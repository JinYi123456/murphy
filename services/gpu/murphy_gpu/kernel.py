"""The shift kernel: a whole batch of shifts advancing together.

A tensor translation of `src/engine/runner.ts::simulateShift`. There is no
python loop over scenarios anywhere in this file - the only loops are over the
procedure's steps, over integration ticks, and over a scenario's own watch and
run-out windows. Every per-scenario decision (does this step fail, which
alternative, has the check caught it, when did the operator act) is a mask, so a
scenario's trajectory is independent of who else is in the batch.

That independence is the point. Random cells are addressed by
(scenario, stream slot, lane) rather than consumed from a cursor, so scenario i
draws exactly the same numbers whether it runs alone or inside a million. A
before/after comparison of a procedure edit is therefore a paired test with no
extra work, and a failure someone clicks on in the UI replays identically.

The reference's per-scenario `break` and `continue` become a liveness mask
(`alive`) and a per-step `process` mask: a shift that stopped early simply stops
having its state advanced, while the rest of the batch keeps going.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

from . import economics, hra, philox, tank

SETUP_SLOTS = 16
MAX_TICK_S = 15
MAX_TICKS = 600
BREAK_HAZARD_S = 240
WATCH_GIVE_UP_S = 400

# the watch failure modes that show up as lateness rather than as a wrong state
LATE_KINDS = ("delayed_response", "misread", "omission")


def slot_for(step_id: str) -> int:
    """Stable stream slot per step id: FNV-1a over the step name.

    This is what keeps a before/after comparison paired across procedure
    revisions - inserting or deleting a step must not reshuffle every other
    step's draws.
    """
    h = 0x811C9DC5
    for ch in step_id:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return (h % 4096) * 8 + SETUP_SLOTS


@dataclass
class ShiftOutcome:
    """Per-scenario record of one shift. Every field is a tensor of length B."""

    cost: torch.Tensor
    failed: torch.Tensor
    outcome: torch.Tensor
    first_causal_step: torch.Tensor
    elapsed: torch.Tensor
    near_miss: torch.Tensor
    hazard_seconds: torch.Tensor
    magnitudes: dict[str, torch.Tensor]
    thrown: torch.Tensor
    escaped: torch.Tensor
    caught: torch.Tensor
    alternative: torch.Tensor
    error_at_s: torch.Tensor
    p: torch.Tensor
    reached: torch.Tensor


def _protect_flag(plant: dict, key: str) -> bool:
    """`rec[k] !== false && rec[k] !== 0`, including when the key is absent."""
    v = plant.get("protection", {}).get(key)
    return not (v is False or v == 0)


def _protect_num(plant: dict, key: str, default: float) -> float:
    v = plant.get("protection", {}).get(key)
    if isinstance(v, bool):
        return default
    return float(v) if isinstance(v, (int, float)) else default


def sample_setup(key, scn: torch.Tensor, plant: dict) -> dict:
    """Shift-level sampling, drawn before any step is reached.

    What the permit left isolated, how far the gauge has drifted, whether the
    drive is degraded, and whether the independent function fails on demand. The
    last three feed the twin's scenario vector, not the HRA worksheet.
    """
    drift = _protect_num(plant, "driftRate", 0.18)
    iso = 1.0 if plant.get("preIsolated") else 0.3
    fod = hra.PROTECTION_FOD["independent_switch"] * (1 if plant.get("provenRecent") else 4)
    one = torch.ones_like(scn, dtype=torch.float64)
    zero = torch.zeros_like(scn, dtype=torch.float64)
    pos = lambda n: scn * 0 + n  # noqa: E731  the stream position of a setup slot
    u0 = philox.draws(key, scn, pos(1), 0)
    u1 = philox.draws(key, scn, pos(2), 1)
    u2 = philox.draws(key, scn, pos(3), 2)
    u3 = philox.draws(key, scn, pos(4), 3)
    u4 = philox.draws(key, scn, pos(5), 0)
    standing = abs(float((plant.get("instrumentDrift") or {}).get("level", 0) or 0))
    return {
        "permitLeftSomethingIsolated": u0 < iso * 0.35,
        "instrumentDrift": torch.where(u1 < drift, (u2 - 0.5) * 2 * (0.3 + standing), zero),
        "driveDegraded": torch.where(u3 < 0.1, 0.72 + u4 * 0.25, one),
        "protectionFailedOnDemand": _protect_flag(plant, "independent") & (u4 < fod),
    }


def _cond_holds(cond: dict, value: torch.Tensor) -> torch.Tensor:
    op = cond["op"]
    if op == "lt":
        return value < cond["value"]
    if op == "lte":
        return value <= cond["value"]
    if op == "gt":
        return value > cond["value"]
    if op == "gte":
        return value >= cond["value"]
    return value == cond["value"]


class _Batch:
    """State and buffers for one batch of shifts."""

    def __init__(
        self, procedure: dict, persona: dict, plant: dict, method: str, seed: str,
        batch: int, device: torch.device, costs: dict,
    ) -> None:
        self.params = tank.PARAMS
        self.iface = tank.IFACE
        self.steps = procedure["steps"]
        self.warnings = [
            {"cond": w["cond"], "level": w["level"], "steps": w["steps"]} for w in procedure.get("warnings") or []
        ]
        self.persona = persona
        self.plant = plant
        self.method = method
        self.cost_table = costs
        self.key = philox.seed_to_key(seed)
        self.device = device
        self.batch = batch
        self.scn = torch.arange(batch, dtype=torch.int64, device=device)
        self.slots = [slot_for(s["id"]) for s in self.steps]

        self.tick = self.iface.get("tickS") or MAX_TICK_S
        self.target = float(self.params[self.iface["target"]])
        self.runout = float(self.iface.get("runoutFactor") or 1.6)
        rate = float(self.params[self.iface["rate"]])
        # the run-out is sized by the physics: enough ticks to reach the
        # completion target plus the run-out factor, whatever the asset
        self.closing_ticks = int(
            min(3000, max(60, math.ceil(self.target * self.runout / max(1e-9, rate * self.tick))))
        )

        self.setup = sample_setup(self.key, self.scn, plant)
        self.s, self.d = tank.zeros(batch, device)
        plant_drift = float((plant.get("instrumentDrift") or {}).get("level", 0) or 0)
        tank.init(
            self.s,
            self.d,
            start_level_frac=plant["freeboardPct"] if plant.get("freeboardPct") is not None else 0.49,
            indicator_bias=plant_drift + self.setup["instrumentDrift"],
            pre_isolated=plant.get("preIsolated") or [],
            protection=plant.get("protection") or {},
            params=self.params,
        )
        self._put_disc(self.iface.get("scale", ""), self.setup["driveDegraded"])
        self._put_disc(self.iface.get("failOnDemand", ""), self.setup["protectionFailedOnDemand"].to(torch.float64))

        f64 = dict(dtype=torch.float64, device=device)
        self.elapsed = torch.zeros(batch, **f64)
        self.planned = torch.zeros(batch, **f64)
        self.hazard_seconds = torch.zeros(batch, **f64)
        self.alive = torch.ones(batch, dtype=torch.bool, device=device)

        n = len(self.steps)
        self.thrown = torch.zeros(batch, n, dtype=torch.bool, device=device)
        self.caught = torch.zeros(batch, n, dtype=torch.bool, device=device)
        self.alternative = torch.zeros(batch, n, dtype=torch.int64, device=device)
        self.error_at = torch.zeros(batch, n, **f64)
        self.p_rec = torch.zeros(batch, n, **f64)
        self.reached = torch.zeros(batch, n, dtype=torch.bool, device=device)

        self._alarm_col = tank.var_index(self.iface["alarm"])
        self._hazard_col = tank.var_index(self.iface["hazard"])
        self._stop_col = tank.disc_index(self.iface["stopFlag"])
        self._run_col = tank.disc_index(self.iface["runFlag"])
        self._prog_col = tank.var_index(self.iface["progress"])
        self._scale_col = tank.disc_index(self.iface.get("scale") or "")

    # ---------------------------------------------------------------- plant io

    def _put_disc(self, name: str, value) -> None:
        i = tank.disc_index(name)
        if i >= 0:
            self.d[:, i] = value

    def read(self, name: str) -> torch.Tensor:
        """A step or a watch criterion may ask for the indicated value, which is
        the true value plus whatever the instrument is wrong by."""
        if name.startswith("indicated:"):
            return tank.indication(self.s, self.d, name[len("indicated:") :])
        i = tank.var_index(name)
        if i < 0:
            return torch.zeros(self.batch, dtype=torch.float64, device=self.device)
        return self.s[:, i]

    def apply_patch(self, patch: dict | None, mask: torch.Tensor) -> None:
        """Assign scenario flags and process variables, as `applyPatch` does: a
        name that resolves to a flag wins, and a name that resolves to neither is
        silently ignored - which is how the reference treats a patch written in
        interface vocabulary rather than twin vocabulary."""
        if not patch:
            return
        for name, value in patch.items():
            di = tank.disc_index(name)
            if di >= 0:
                self.d[:, di] = torch.where(mask, float(value), self.d[:, di])
                continue
            vi = tank.var_index(name)
            if vi >= 0:
                self.s[:, vi] = torch.where(mask, float(value), self.s[:, vi])

    # ------------------------------------------------------------ integration

    def advance_ticks(self, dt: torch.Tensor) -> None:
        tank.advance(self.s, self.d, self.params, dt)
        self.elapsed = self.elapsed + dt
        self.hazard_seconds = self.hazard_seconds + torch.where(
            self.s[:, self._hazard_col] > 0, dt, torch.zeros_like(dt)
        )

    def integrate_for(self, dur: torch.Tensor, active: torch.Tensor, cap: int = MAX_TICKS) -> None:
        """Split each scenario's own duration into at most `cap` ticks, matching
        `integrateFor`.

        The tick count differs between scenarios because the duration draw does,
        so the batch walks the longest one and the rest wait at dt = 0.
        """
        dur = torch.where(active, dur, torch.zeros_like(dur))
        n = torch.clamp(torch.ceil(dur / self.tick).to(torch.int64), min=1, max=cap)
        dt = dur / n.to(torch.float64)
        for i in range(int(n.max().item())):
            self.advance_ticks(dt * (i < n).to(torch.float64))

    def _advance_while(self, running: torch.Tensor) -> None:
        self.advance_ticks(running.to(torch.float64) * self.tick)

    # ------------------------------------------------------------------ draws

    def draw(self, slot: int, lane: int) -> torch.Tensor:
        return philox.draws(self.key, self.scn, torch.full_like(self.scn, int(slot)), lane)

    def pick_alternative(self, slot: int, weights: list[float]) -> torch.Tensor:
        """First alternative whose weight exhausts the draw.

        Sequential subtraction rather than a cumsum search, because that is what
        the reference does and a tie on a boundary must land on the same row.
        """
        total = 0.0
        for w in weights:
            total += w
        r = self.draw(slot, 1) * total
        pick = torch.full_like(self.scn, len(weights) - 1)
        assigned = torch.zeros_like(pick, dtype=torch.bool)
        for i, w in enumerate(weights):
            r = r - w
            hit = (r <= 0) & ~assigned
            pick = torch.where(hit, torch.full_like(pick, i), pick)
            assigned = assigned | hit
        return pick

    # --------------------------------------------------------------- worksheet

    def conditions(self, step: dict, slip: torch.Tensor, alarm, hazard, with_warnings: bool = True):
        """An emerging-situation worksheet.

        `with_warnings` is off for the checking action and the emergency action:
        the reference does not re-apply the procedure's design warnings there,
        because those describe the step as written rather than the act of
        checking or recovering.
        """
        return hra.conditions_for(
            step,
            self.persona,
            self.plant,
            {
                "slipRatio": slip,
                "alarmRinging": alarm,
                "hazardSeen": hazard,
                "permitLeftSomethingIsolated": self.setup["permitLeftSomethingIsolated"],
                "instrumentDrift": self.setup["instrumentDrift"],
            },
            self.warnings if with_warnings else [],
            batch=self.batch,
            device=self.device,
        )

    # ---------------------------------------------------------------- per step

    def run_step(self, j: int) -> None:
        step = self.steps[j]
        slot = self.slots[j]
        dur_s = float(step["durS"])
        # slip is measured against what was planned *before* this step: the
        # schedule allowance for the step in hand is not yet overdue
        denom = torch.where(self.planned > 0, self.planned, torch.ones_like(self.planned))
        slip = torch.where(self.planned > 0, self.elapsed / denom, torch.ones_like(self.elapsed))
        t_start = self.elapsed.clone()

        process = self.alive
        if step.get("guard"):
            process = process & _cond_holds(step["guard"], self.read(step["guard"]["var"]))
        if not bool(process.any()):
            return

        alarm_ringing = (self.s[:, self._alarm_col] == 1) & (self.d[:, self._stop_col] == 0)
        hazard_seen = self.s[:, self._hazard_col] > 0

        conds = self.conditions(step, slip, alarm_ringing, hazard_seen)
        level, severity, _ = hra.assess(step, self.persona, self.plant, conds, self.batch, self.device)
        hep = hra.compute_hep(
            level,
            severity,
            self.method,
            step["kind"],
            gtt=step.get("gtt"),
            similarity=step.get("similarity"),
            inside_procedure=("applies" in step) or ("verify" in step),
        )

        self.reached[:, j] = process
        self.p_rec[:, j] = hep["p"]

        surface = step.get("errors") or []
        thrown = torch.zeros_like(process)
        if surface:
            thrown = process & (self.draw(slot, 0) < hep["p"])
            pick = self.pick_alternative(slot, [float(e["weight"]) for e in surface])
            self.alternative[:, j] = torch.where(thrown, pick, self.alternative[:, j])
            for i, alt in enumerate(surface):
                self.apply_patch(alt.get("patch"), thrown & (pick == i))
            still_does = torch.zeros_like(thrown)
            for i, alt in enumerate(surface):
                still_does = still_does | ((pick == i) & bool(alt.get("alsoApplies")))
            # an operator who does the wrong thing may still do the right thing
            # as well, which is what `alsoApplies` records
            self.apply_patch(step.get("applies"), process & (~thrown | still_does))
        else:
            self.apply_patch(step.get("applies"), process)

        self.thrown[:, j] = thrown
        self.error_at[:, j] = self.elapsed

        if step.get("verify"):
            self.run_verify(j, step, slot, process, slip)

        if step.get("watch"):
            self.run_watch(j, step, slot, process)
        else:
            u4 = self.draw(slot, 4)
            self.integrate_for(dur_s * (0.75 + 0.5 * u4), process)
            if step.get("until"):
                lim = self.read(step["until"]["var"])
                scale = self.d[:, self._scale_col]
                # a drive scaled to zero is no drive at all, so the nominal rate
                # is used rather than dividing by nothing
                eff = torch.where(scale != 0, scale, torch.ones_like(scale))
                rate = torch.clamp(float(self.params[self.iface["rate"]]) * eff, min=1e-9)
                need = process & (lim < step["until"]["atLeast"])
                self.integrate_for(
                    torch.clamp((step["until"]["atLeast"] - lim) / rate, max=3600.0), need
                )

        # the reference re-reads the hazard *after* the step has run, so this has
        # to use the fresh value: a release caused by this very step can be what
        # ends the shift
        broke = process & (self.s[:, self._hazard_col] > 0) & (self.hazard_seconds > BREAK_HAZARD_S)
        self.alive = self.alive & ~broke

        # schedule drift is the overrun, not the duration: a monitoring step that
        # takes the time it was given has not made the crew late. Without this a
        # long cure stamps every following step as operating under extreme time
        # pressure, which is a modelling error rather than a finding.
        watch = step.get("watch") or {}
        allowance = dur_s + float(watch.get("scheduledS") if watch.get("scheduledS") is not None
                                 else (watch.get("maxWaitS") if watch.get("maxWaitS") is not None else 0))
        drift = torch.clamp(self.elapsed - t_start, max=allowance)
        spent = torch.maximum(torch.full_like(drift, dur_s), drift)
        self.planned = torch.where(process, self.planned + spent, self.planned)

    def run_verify(self, j: int, step: dict, slot: int, process: torch.Tensor, slip) -> None:
        spec = step["verify"]
        sources = [k for k, s in enumerate(self.steps) if s["id"] in spec["of"]]
        open_any = torch.zeros_like(process)
        for k in sources:
            open_any = open_any | (self.thrown[:, k] & ~self.caught[:, k])
        if not bool((process & open_any).any()):
            return

        # the checking action is scored with the alarm deliberately ignored: the
        # question is whether the check finds the deviation, and the distraction
        # that the alarm causes is already on the worksheet for the step itself
        conds = self.conditions(
            step, slip, False, self.s[:, self._hazard_col] > 0, with_warnings=False
        )
        level, severity, _ = hra.assess(step, self.persona, self.plant, conds, self.batch, self.device)
        pdet = hra.detection_probability(
            level,
            severity,
            self.method,
            spec.get("kind") or "verify",
            gtt=spec.get("gtt"),
            similarity=step.get("similarity"),
            inside_procedure=True,
        )
        detect = process & open_any & (self.draw(slot, 2) < pdet)

        for k in sources:
            src = self.steps[k]
            hit0 = detect & self.thrown[:, k] & ~self.caught[:, k]
            if not bool(hit0.any()):
                continue
            self.caught[:, k] = self.caught[:, k] | hit0
            applies = src.get("applies") or {}
            for i, alt in enumerate(src.get("errors") or []):
                hit = hit0 & (self.alternative[:, k] == i)
                if not bool(hit.any()):
                    continue
                for name in (alt.get("patch") or {}):
                    if name in applies:
                        continue
                    di = tank.disc_index(name)
                    if di >= 0:
                        # undo the flag the error set, then re-apply what the step
                        # intended: the check restores the configuration rather
                        # than rolling back a history
                        self.d[:, di] = torch.where(hit, 0.0, self.d[:, di])
                self.apply_patch(src.get("applies"), hit)

    def run_watch(self, j: int, step: dict, slot: int, process: torch.Tensor) -> None:
        """Cue seen at time T, acted at T + lateness.

        Lateness is modelled as time and not as a shifted threshold, because time
        is the unit the overfill guidance measures response budgets in. The batch
        watches together and each scenario stops looking when it has acted.
        """
        w = step["watch"]
        late = torch.zeros_like(process)
        for i, alt in enumerate(step.get("errors") or []):
            if alt["kind"] in LATE_KINDS:
                late = late | (self.thrown[:, j] & (self.alternative[:, j] == i))
        late_max = float(w["lateMaxS"]) if w.get("lateMaxS") is not None else 240.0
        u3 = self.draw(slot, 3)
        late_s = torch.where(late, (0.15 + 0.85 * u3) * late_max, torch.zeros_like(u3))

        max_wait = float(w["maxWaitS"]) if w.get("maxWaitS") is not None else 1500.0
        t0 = self.elapsed.clone()
        armed = torch.full_like(self.elapsed, -1.0)
        active = process.clone()

        for _ in range(int(math.ceil(max_wait / self.tick)) + 1):
            body = active & ((self.elapsed - t0) < max_wait)
            if not bool(body.any()):
                break
            v = self.read(w["var"])
            met = torch.zeros_like(body)
            if w.get("atLeast") is not None:
                met = met | (v >= float(w["atLeast"]))
            if w.get("atMost") is not None:
                met = met | (v <= float(w["atMost"]))
            if w.get("alt"):
                met = met | (self.read(w["alt"]["var"]) >= float(w["alt"]["atLeast"]))
            armed = torch.where(body & met & (armed < 0), self.elapsed, armed)

            act = body & (armed >= 0) & ((self.elapsed - armed) >= late_s)
            self.apply_patch(w.get("onHit"), act)
            active = active & ~act

            # whichever comes first: the criterion, the machine tripping, or the
            # release making the watch pointless
            cont = body & ~act
            self._advance_while(cont)
            stopped = cont & (self.d[:, self._stop_col] == 1)
            active = active & ~stopped
            given_up = cont & ~stopped & (self.s[:, self._hazard_col] > 0) & ((self.elapsed - t0) > WATCH_GIVE_UP_S)
            active = active & ~given_up

    def run_closing(self) -> None:
        """Whatever is still running keeps running until it is finished or shut
        down, with the emergency response armed for the whole of that."""
        em_index = next((i for i, s in enumerate(self.steps) if s.get("emergency")), None)
        rolled = torch.zeros(self.batch, dtype=torch.bool, device=self.device)

        for _ in range(self.closing_ticks):
            running = (
                (self.d[:, self._run_col] == 1)
                & (self.d[:, self._stop_col] == 0)
                & (self.s[:, self._prog_col] < self.target * self.runout)
            )
            if not bool(running.any()):
                break

            if em_index is not None:
                step = self.steps[em_index]
                roll = running & (self.s[:, self._hazard_col] > 0) & ~rolled
                if bool(roll.any()):
                    rolled = rolled | roll
                    conds = self.conditions(
                        step,
                        torch.ones_like(self.elapsed),
                        True,
                        torch.ones_like(rolled),
                        with_warnings=False,
                    )
                    # an unprepared exception is what a release during a transfer
                    # is, whatever the procedure said about this step
                    for forced in ("unprepared_exception", "situation_awareness"):
                        two = torch.full_like(self.elapsed, 2, dtype=torch.int64)
                        conds[forced] = two if conds.get(forced) is None else torch.maximum(conds[forced], two)
                    level, severity, _ = hra.assess(step, self.persona, self.plant, conds, self.batch, self.device)
                    hep = hra.compute_hep(level, severity, self.method, step["kind"], inside_procedure=True)
                    spec = step["emergency"]
                    slot = slot_for(step["id"])
                    acted = roll & (self.draw(slot, 5) >= hep["p"])
                    late_s = float(spec["maxResponseS"]) * self.draw(slot, 6)
                    self.integrate_for(late_s, acted, cap=40)
                    self.apply_patch(spec.get("onHit"), acted)

            self._advance_while(running)

    def finish(self) -> ShiftOutcome:
        codes = tank.classify_codes(self.s, self.d, self.params)
        mag = tank.magnitudes(self.s, self.d, self.params)
        money = economics.cost_tank(
            codes, mag, self.plant.get("product") or "default", self.cost_table, tank.OUTCOME_CLASSES
        )
        failed = (codes != tank.OUTCOME_CLASSES.index("normal")) & (
            codes != tank.OUTCOME_CLASSES.index("intercepted")
        )
        escaped = self.thrown & ~self.caught
        first_causal = torch.where(
            escaped.any(dim=1),
            escaped.to(torch.int64).argmax(dim=1),
            torch.full_like(codes, -1),
        )
        return ShiftOutcome(
            cost=money["totalEur"],
            failed=failed,
            outcome=codes,
            first_causal_step=first_causal,
            elapsed=self.elapsed,
            near_miss=~failed & (self.s[:, self._alarm_col] == 1),
            hazard_seconds=self.hazard_seconds,
            magnitudes=mag,
            thrown=self.thrown,
            escaped=escaped,
            caught=self.caught,
            alternative=self.alternative,
            error_at_s=self.error_at,
            p=self.p_rec,
            reached=self.reached,
        )

    def run(self) -> ShiftOutcome:
        for j in range(len(self.steps)):
            self.run_step(j)
        self.run_closing()
        return self.finish()


def run_shifts(
    procedure: dict,
    persona: dict,
    plant: dict,
    method: str,
    seed: str,
    batch: int,
    device="cpu",
    costs: dict | None = None,
) -> ShiftOutcome:
    """Simulate `batch` shifts of one configuration; scenario i is paired by index."""
    if costs is None:
        raise ValueError("a costs table is required: pass the parsed data/costs.json")
    dev = device if isinstance(device, torch.device) else torch.device(device)
    return _Batch(procedure, persona, plant, method, seed, batch, dev, costs).run()
