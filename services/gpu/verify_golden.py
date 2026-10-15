#!/usr/bin/env python
"""Gate the batched re-implementation against the golden fixtures.

The fixtures are the contract, not the TypeScript source: if the two engines
disagree, one of them is wrong and the disagreement is a bug report rather than a
rounding note. This script therefore reports measured agreement against explicit
tolerances and exits non-zero when a gate fails.

Gates, as specified:
  philox      100% exact u32 words
  tank_steps  state exact to 1e-9 relative
  hep         p exact to 1e-12 relative
  shifts      outcome class match >= 99.5%, cost within 1e-6 relative on the
              scenarios whose class matched

Run:  python verify_golden.py [--quick] [--device cpu|cuda]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch

from murphy_gpu import hra, kernel, philox, tank

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "data" / "golden"
DATA = REPO / "data"

TANK_REL = 1e-9
HEP_REL = 1e-12
SHIFT_CLASS_GATE = 0.995
COST_REL = 1e-6

PASS, FAIL = "PASS", "FAIL"


def load(path: Path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def rel_err(got: torch.Tensor, exp: torch.Tensor) -> torch.Tensor:
    """Relative error that treats an expected zero as an absolute comparison -
    otherwise half the tank state would be judged against a zero denominator."""
    diff = (got - exp).abs()
    return torch.where(exp.abs() < 1e-12, diff, diff / exp.abs().clamp_min(1e-300))


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str, str, str]] = []
        self.ok = True

    def add(self, fixture: str, gate: str, measured: str, passed: bool, detail: str = "") -> None:
        self.rows.append((fixture, gate, measured, PASS if passed else FAIL, detail))
        self.ok = self.ok and passed

    def print(self) -> None:
        widths = [max(len(str(r[i])) for r in self.rows + [("fixture", "gate", "measured", "result", "detail")]) for i in range(5)]
        header = ("fixture", "gate", "measured", "result", "detail")
        print()
        print("  ".join(h.ljust(widths[i]) for i, h in enumerate(header)))
        print("  ".join("-" * widths[i] for i in range(5)))
        for row in self.rows:
            print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
        print()
        print("OVERALL:", PASS if self.ok else FAIL)


def check_philox(rep: Report, device: torch.device) -> None:
    fx = load(GOLDEN / "philox.json")
    key = philox.seed_to_key(fx["seed"])
    rep.add("philox.json", "seedToKey exact", str(list(key)), list(key) == list(fx["key"]), f"expected {fx['key']}")

    vectors = fx["vectors"]
    scn = torch.tensor([v["scn"] for v in vectors], dtype=torch.int64, device=device)
    pos = torch.tensor([v["pos"] for v in vectors], dtype=torch.int64, device=device)
    exp = torch.tensor([v["u32"] for v in vectors], dtype=torch.int64, device=device)
    lanes = torch.tensor([v["lane"] for v in vectors], dtype=torch.int64, device=device)

    got = torch.zeros_like(exp)
    for lane in range(4):
        sel = torch.nonzero(lanes == lane).flatten()
        if sel.numel():
            got[sel] = philox.draw_u32(key, scn[sel], pos[sel], lane)
    bad = int((got != exp).sum())
    rep.add("philox.json", "u32 100% exact", f"{len(exp) - bad}/{len(exp)}", bad == 0,
            "" if bad == 0 else f"first bad vector {int(torch.nonzero(got != exp)[0][0])}")

    # the counter must not leak magnitude into the low bits of the fraction
    frac = philox.draws(key, scn, pos, 0)
    rep.add("philox.json", "draws in [0,1)", f"[{float(frac.min()):.4f}, {float(frac.max()):.4f}]",
            bool((frac >= 0).all() and (frac < 1).all()))


def check_tank(rep: Report, device: torch.device) -> None:
    fx = load(GOLDEN / "tank_steps.json")
    params = fx["params"]
    cases = fx["cases"]
    batch = len(cases)
    if fx["discs"] != tank.DISCS or fx["vars"] != tank.VARS:
        rep.add("tank_steps.json", "layout matches twin definition", "vars/discs differ", False,
                "fixture layout is not what murphy_gpu.tank declares")
        return

    state, disc = tank.zeros(batch, device)
    for i, case in enumerate(cases):
        for name, value in case["disc"].items():
            disc[i, tank.disc_index(name)] = float(value)
    tank.init(
        state,
        disc,
        start_level_frac=[c["startLevelFrac"] for c in cases],
        indicator_bias=[c["disc"].get("gaugeBias", 0.0) for c in cases],
        protection={},
        params=params,
    )
    for _ in range(fx["ticks"]):
        tank.advance(state, disc, params, fx["dtS"])

    exp = torch.tensor([c["state"] for c in cases], dtype=torch.float64, device=device)
    err = rel_err(state, exp)
    worst = float(err.max())
    over = int((err > TANK_REL).sum())
    rep.add("tank_steps", f"state within {TANK_REL:g} rel", f"{worst:.2e} ({over}/{err.numel()} over)",
            over == 0)

    exp_after = torch.tensor([c["after"] for c in cases], dtype=torch.float64, device=device)
    derr = float((disc - exp_after).abs().max())
    rep.add("tank_steps", "scenario vector after 40 ticks", f"{derr:.2e} abs", derr == 0.0)

    codes = tank.classify_codes(state, disc, params)
    got_cls = [tank.OUTCOME_CLASSES[int(c)] for c in codes.cpu()]
    mism = [i for i, c in enumerate(cases) if got_cls[i] != c["classify"]]
    rep.add("tank_steps", "classify exact", f"{batch - len(mism)}/{batch}", not mism,
            "" if not mism else f"cases {mism[:5]}")

    mag = tank.magnitudes(state, disc, params)
    mkeys = [k for k in mag if k in cases[0]["magnitudes"]]
    bad = [
        (k, i)
        for k in mkeys
        for i in range(batch)
        if abs(float(mag[k][i]) - float(cases[i]["magnitudes"][k])) > 1e-6
    ]
    rep.add("tank_steps", "magnitudes within 1e-6", f"{len(mkeys) * batch - len(bad)}/{len(mkeys) * batch}",
            not bad, "" if not bad else str(bad[:4]))

    # a scenario that only ever sits at its start level is a weak test, and the
    # reason is in the reference: init() rewrites the whole scenario vector, so
    # the designed discrete matrix the generator feeds in does not survive it.
    distinct = len({tuple(c["disc"].items()) for c in cases})
    live = sum(1 for c in cases if float(c["state"][tank.var_index("pumpTime")]) > 0)
    rep.add("tank_steps", "coverage note", f"{live}/{batch} cases pump, {distinct} distinct disc sets",
            True, "init() discards the generator's flags upstream; implemented faithfully")


def check_hep(rep: Report, device: torch.device, limit: int | None = None) -> None:
    fx = load(GOLDEN / "hep.json")
    procedure = load(DATA / "procedures" / "OP-TRF-014.json")
    personas = {p["id"]: p for p in load(DATA / "personas.json")}
    plants = {p["id"]: p for p in load(DATA / "plants.json") if p.get("twin") == "tank_transfer"}
    steps = {s["id"]: s for s in procedure["steps"]}
    warnings = [{"cond": w["cond"], "level": w["level"], "steps": w["steps"]} for w in procedure.get("warnings") or []]

    rows = fx[:limit] if limit else fx
    worst_p = worst_c = 0.0
    bad: list[str] = []
    nom_bad = adj_bad = level_bad = 0
    for row in rows:
        step = steps[row["step"]]
        # the HEP fixture is a static worksheet: nominal slip, no alarm, no
        # hazard, nothing left isolated by a permit
        ctx = {
            "slipRatio": 1.12,
            "alarmRinging": False,
            "hazardSeen": False,
            "permitLeftSomethingIsolated": False,
            "instrumentDrift": 0.0,
        }
        conds = hra.conditions_for(step, personas[row["persona"]], plants[row["plant"]], ctx, warnings, 1, device)
        level, severity, _ = hra.assess(step, personas[row["persona"]], plants[row["plant"]], conds, 1, device)
        hep = hra.compute_hep(
            level, severity, row["method"], step["kind"],
            gtt=step.get("gtt"), similarity=step.get("similarity"),
            inside_procedure=bool(step.get("applies")),
        )
        p, c = float(hep["p"][0]), float(hep["multiplier"][0])
        worst_p = max(worst_p, abs(p - row["p"]) / max(1e-12, abs(row["p"])))
        worst_c = max(worst_c, abs(c - row["multiplier"]) / max(1e-12, abs(row["multiplier"])))
        if hep["nominal"] != row["nominal"]:
            nom_bad += 1
        if bool(hep["adjusted"][0]) != row["adjusted"]:
            adj_bad += 1
            bad.append(f"{row['step']}/{row['persona']}/{row['plant']}/{row['method']} adjusted")
        if hra.level_labels(level, row["method"], severity)[0] != row["levels"]:
            level_bad += 1
            bad.append(f"{row['step']}/{row['persona']}/{row['plant']}/{row['method']} levels")

    n = len(rows)
    rep.add("hep.json", f"p within {HEP_REL:g} rel", f"{worst_p:.2e} over {n} rows", worst_p <= HEP_REL * 1.0001)
    rep.add("hep.json", "multiplier within 1e-12 rel", f"{worst_c:.2e}", worst_c <= HEP_REL * 1.0001)
    rep.add("hep.json", "nominal rate exact", f"{n - nom_bad}/{n}", nom_bad == 0)
    rep.add("hep.json", "adjustment factor flag exact", f"{n - adj_bad}/{n}", adj_bad == 0)
    rep.add("hep.json", "PSF derivation strings exact", f"{n - level_bad}/{n}", level_bad == 0,
            "; ".join(bad[:3]))


def _error_strings(out: kernel.ShiftOutcome, i: int, procedure: dict) -> list[str]:
    """The escaped deviation list for one scenario, in the fixture's format."""
    steps = procedure["steps"]
    result = []
    for j, step in enumerate(steps):
        if bool(out.escaped[i, j]):
            alt = step["errors"][int(out.alternative[i, j])]
            result.append(f"{step['id']}/{alt['id']}@{float(out.error_at_s[i, j]):.1f}")
    return result


def _caught_strings(out: kernel.ShiftOutcome, i: int, procedure: dict) -> list[str]:
    steps = procedure["steps"]
    keys = [
        f"{s['id']}/{s['errors'][int(out.alternative[i, j])]['id']}"
        for j, s in enumerate(steps)
        if bool(out.caught[i, j])
    ]
    return sorted(keys)


def first_divergent_step(out: kernel.ShiftOutcome, i: int, expected: dict, procedure: dict) -> str:
    """Where this scenario first leaves the reference's trajectory."""
    got_err = [e.split("@")[0] for e in _error_strings(out, i, procedure)]
    exp_err = [e.split("@")[0] for e in expected["errors"]]
    steps = procedure["steps"]
    ids = [s["id"] for s in steps]
    for k in range(max(len(got_err), len(exp_err))):
        g = got_err[k] if k < len(got_err) else "-"
        e = exp_err[k] if k < len(exp_err) else "-"
        if g != e:
            want = e.split("/")[0] if e != "-" else "?"
            at = ids.index(want) if want in ids else -1
            return f"step {want} (index {at}): errors {g} vs {e}"
    if abs(float(out.elapsed[i]) - expected["elapsedS"]) > 1e-3:
        return f"no error divergence; elapsed {float(out.elapsed[i]):.3f} vs {expected['elapsedS']:.3f}"
    return "outcome class only"


def check_shifts(rep: Report, device: torch.device, quick: bool, limit_groups: int | None = None) -> None:
    fx = load(GOLDEN / "shifts.json")
    procedure = load(DATA / "procedures" / "OP-TRF-014.json")
    personas = {p["id"]: p for p in load(DATA / "personas.json")}
    plants = {p["id"]: p for p in load(DATA / "plants.json") if p.get("twin") == "tank_transfer"}
    costs = load(DATA / "costs.json")

    groups: dict[tuple, list[dict]] = {}
    for row in fx:
        groups.setdefault((row["plant"], row["persona"], row["method"], row["seed"]), []).append(row)

    total = matched = cost_ok = 0
    mismatches: list[str] = []
    peak_bad = 0
    t0 = time.time()
    keys = sorted(groups)
    cap = limit_groups if limit_groups is not None else (4 if quick else len(keys))
    keys = keys[:cap]
    for plant_id, persona_id, method, seed in keys:
        rows = sorted(groups[(plant_id, persona_id, method, seed)], key=lambda r: r["scn"])
        n = len(rows)
        out = kernel.run_shifts(
            procedure, personas[persona_id], plants[plant_id], method, seed, n, device, costs
        )
        for i, expected in enumerate(rows):
            total += 1
            got_cls = tank.OUTCOME_CLASSES[int(out.outcome[i])]
            if got_cls == expected["outcome"]:
                matched += 1
                got_cost = float(out.cost[i])
                exp_cost = float(expected["costEur"])
                if abs(got_cost - exp_cost) <= COST_REL * max(1.0, abs(exp_cost)):
                    cost_ok += 1
                else:
                    mismatches.append(
                        f"{plant_id}/{persona_id}/{method} scn{expected['scn']}: cost {got_cost:.3f} vs {exp_cost:.3f}"
                    )
                got_el, exp_el = float(out.elapsed[i]), float(expected["elapsedS"])
                if abs(got_el - exp_el) > 1e-3:
                    mismatches.append(
                        f"{plant_id}/{persona_id}/{method} scn{expected['scn']}: elapsed {got_el:.3f} vs {exp_el:.3f} "
                        f"({first_divergent_step(out, i, expected, procedure)})"
                    )
                if _caught_strings(out, i, procedure) != expected["caught"]:
                    mismatches.append(
                        f"{plant_id}/{persona_id}/{method} scn{expected['scn']}: caught "
                        f"{_caught_strings(out, i, procedure)} vs {expected['caught']}"
                    )
                mag = out.magnitudes
                for k, v in expected["peak"].items():
                    if k in mag and abs(float(mag[k][i]) - float(v)) > 1e-4 * max(1.0, abs(float(v))):
                        peak_bad += 1
                        break
            else:
                mismatches.append(
                    f"{plant_id}/{persona_id}/{method} scn{expected['scn']}: class {got_cls} vs {expected['outcome']} "
                    f"- {first_divergent_step(out, i, expected, procedure)}"
                )

    rate = matched / total if total else 0.0
    rep.add("shifts.json", f"outcome class >= {SHIFT_CLASS_GATE:.1%}", f"{rate:.4%} ({matched}/{total})",
            rate >= SHIFT_CLASS_GATE, f"{time.time() - t0:.1f}s to replay, device {device}")
    rep.add("shifts.json", f"cost within {COST_REL:g} rel on matched", f"{cost_ok}/{matched}",
            cost_ok == matched)
    rep.add("shifts.json", "peak magnitudes within 1e-4", f"{matched - peak_bad}/{matched}", peak_bad == 0)
    if mismatches:
        print(f"\n  {len(mismatches)} divergent scenario(s); first 20:")
        for m in mismatches[:20]:
            print("   ", m)


def check_paired(rep: Report, device: torch.device) -> None:
    """Common random numbers: scenario i must not care how big the batch is."""
    procedure = load(DATA / "procedures" / "OP-TRF-014.json")
    personas = {p["id"]: p for p in load(DATA / "personas.json")}
    plants = {p["id"]: p for p in load(DATA / "plants.json") if p.get("twin") == "tank_transfer"}
    costs = load(DATA / "costs.json")
    plant = plants["tk_after_instrument_work"]
    persona = personas["night_trainee"]
    method = "sparh"
    seed = "G-paired-crn"
    size = 1000

    whole = kernel.run_shifts(procedure, persona, plant, method, seed, size, device, costs)
    again = kernel.run_shifts(procedure, persona, plant, method, seed, size, device, costs)
    same = bool(
        torch.equal(again.outcome, whole.outcome)
        and torch.equal(again.thrown, whole.thrown)
        and torch.equal(again.caught, whole.caught)
        and torch.equal(again.elapsed, whole.elapsed)
        and torch.equal(again.cost, whole.cost)
    )
    rep.add("CRN", "two identical batch-1000 runs agree", "outcome/errors/elapsed/cost", same)

    one = kernel.run_shifts(procedure, persona, plant, method, seed, 1, device, costs)
    head_ok = bool(
        int(one.outcome[0]) == int(whole.outcome[0])
        and float(one.elapsed[0]) == float(whole.elapsed[0])
        and float(one.cost[0]) == float(whole.cost[0])
        and torch.equal(one.thrown[0], whole.thrown[0])
    )
    rep.add("CRN", "batch=1 scenario 0 == batch=1000 scenario 0", "exact" if head_ok else "diverged", head_ok)

    # a smaller batch starting at the same scenario must give the same answers,
    # which is the property a paired before/after comparison rests on
    part = kernel.run_shifts(procedure, persona, plant, method, seed, 250, device, costs)
    part_ok = bool(
        torch.equal(part.outcome, whole.outcome[:250])
        and torch.equal(part.elapsed, whole.elapsed[:250])
        and torch.equal(part.cost, whole.cost[:250])
    )
    rep.add("CRN", "batch=250 is a prefix of batch=1000", "exact" if part_ok else "diverged", part_ok)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="check four shift groups only")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--limit-hep", type=int, default=None)
    args = ap.parse_args()

    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        print("no GPU visible for device=cuda; falling back to cpu")
        device = torch.device("cpu")

    print(f"murphy_gpu golden verification on {device} / torch {torch.__version__}")
    rep = Report()
    check_philox(rep, device)
    check_tank(rep, device)
    check_hep(rep, device, args.limit_hep)
    check_shifts(rep, device, args.quick)
    check_paired(rep, device)
    rep.print()
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
