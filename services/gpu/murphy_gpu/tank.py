"""Batched process twin for the road-tanker to TK-101 transfer.

A line-for-line tensor translation of `src/engine/twins/tank.ts`. The state and
scenario layouts below are the wire format shared by both engines, so a state
vector can be handed to either side.

Every update uses only + - * /, comparisons and clamping. There is no
transcendental anywhere in the physics, which is what lets a CPU batch and a
GPU batch follow the same trajectory: no reformulation is needed to get the
same answer, only the same operation order.

Continuous state (index = wire position):
   0 level m | 1 lineP bar | 2 stress s | 3 spill m3 | 4 bund m3
   5 escaped m3 | 6 diverted m3 | 7 pumpTime s | 8 t s | 9 delivered m3
  10 peakLineP bar | 11 tankP mbar | 12 lahLatched | 13 ahLatched
  14 lineFailed | 15 overflowed | 16 roofFailed | 17 secsSinceAl (-1 before)
  18 oneShotDone

Scenario state:
   0 V1 | 1 V2 | 2 V3 | 3 V4 | 4 PUMP | 5 LAH | 6 PIS | 7 RACK | 8 STOP
   9 PISFAIL | 10 gaugeBias m | 11 scale | 12 V3LEAK | 13 BUND_HEADROOM
  14 BOND_OK | 15 HAMMER | 16 HOSE_SPILL | 17 AUTO_TRIP
"""

from __future__ import annotations

import torch

VARS = [
    "level", "lineP", "stress", "spill", "bund", "escaped", "diverted", "pumpTime", "t",
    "delivered", "peakLineP", "tankP", "lahLatched", "ahLatched", "lineFailed", "overflowed",
    "roofFailed", "secsSinceAl", "oneShotDone",
]
DISCS = [
    "V1", "V2", "V3", "V4", "PUMP", "LAH", "PIS", "RACK", "STOP", "PISFAIL", "gaugeBias", "scale",
    "V3LEAK", "BUND_HEADROOM", "BOND_OK", "HAMMER", "HOSE_SPILL", "AUTO_TRIP",
]

N_VARS = len(VARS)
N_DISCS = len(DISCS)

# Named exactly as tank.ts names them, so the fixture's `params` object can be
# passed straight in without a translation table.
PARAMS: dict[str, float] = {
    "area": 12.6,
    "hOverflow": 10.0,
    "hAl": 9.3,
    "hAh": 9.6,
    "qPump": 110,
    "qOut": 90,
    "crossFrac": 0.6,
    "pDead": 82,
    "pRun": 7.5,
    "tauP": 8,
    "pRating": 25,
    "stressFail": 40,
    "burstM3": 7,
    "leakQ": 45,
    "bundCap": 55,
    "batchM3": 55,
    "pRoof": 45,
    "tauVent": 4,
    "roofBurstM3": 14,
    "progressRate": 110 / 3600,
    "weepQ": 12,
    "hammerM3": 0.5,
    "hoseM3": 0.3,
    "walkS": 55,
    "actS": 20,
}

IFACE = {
    "progress": "delivered",
    "target": "batchM3",
    "rate": "progressRate",
    "runFlag": "PUMP",
    "stopFlag": "STOP",
    "alarm": "lahLatched",
    "hazard": "spill",
    "clock": "t",
    "bias": "gaugeBias",
    "scale": "scale",
    "failOnDemand": "PISFAIL",
}

# Order matters: classify() returns the first match, and the codes have to be
# stable so the outcome-class gate in verify_golden is meaningful.
OUTCOME_CLASSES = [
    "normal",
    "intercepted",
    "minor_release",
    "overfill",
    "containment_escape",
    "line_failure",
    "tank_breach",
    "misrouting",
    "no_flow",
    "short_batch",
    "trip_stop",
]
_CLASS_CODE = {name: i for i, name in enumerate(OUTCOME_CLASSES)}

I = {name: i for i, name in enumerate(VARS)}
D = {name: i for i, name in enumerate(DISCS)}


def var_index(name: str) -> int:
    return I.get(name, -1)


def disc_index(name: str) -> int:
    return D.get(name, -1)


def zeros(batch: int, device=None) -> tuple[torch.Tensor, torch.Tensor]:
    """Fresh (state, disc) buffers for a batch. float64 throughout: the model
    is calibrated on doubles and a float32 state changes which side of a set
    point a scenario lands on."""
    s = torch.zeros(batch, N_VARS, dtype=torch.float64, device=device)
    d = torch.zeros(batch, N_DISCS, dtype=torch.float64, device=device)
    return s, d


def _broadcast(value, batch: int, device) -> torch.Tensor:
    """Accept a scalar, a sequence or a tensor as one per-scenario column."""
    if isinstance(value, torch.Tensor):
        t = value.to(dtype=torch.float64, device=device)
    elif isinstance(value, (list, tuple)):
        t = torch.tensor(value, dtype=torch.float64, device=device)
    else:
        return torch.full((batch,), float(value), dtype=torch.float64, device=device)
    if t.numel() == batch:
        return t.reshape(batch)
    return torch.full((batch,), float(t.reshape(-1)[0]), dtype=torch.float64, device=device)


def init(
    state: torch.Tensor,
    disc: torch.Tensor,
    *,
    start_level_frac,
    indicator_bias,
    pre_isolated=(),
    protection=None,
    params: dict[str, float] | None = None,
) -> None:
    """Fill the state and scenario vectors, exactly as `init` does in TS.

    Note the discipline this file keeps: `init` writes every scenario flag, so
    anything a caller seeded into `disc` beforehand is discarded. The reference
    behaves the same way and the golden tank fixture depends on it; per-scenario
    variation therefore has to be applied *after* init, which is what the
    kernel does.
    """
    isolated = set(pre_isolated or ())
    prot = protection or {}
    p = params or PARAMS
    batch, device = state.shape[0], state.device
    frac = _broadcast(start_level_frac, batch, device)
    bias = _broadcast(indicator_bias, batch, device)

    state[:, I["level"]] = p["hOverflow"] * frac
    for i in range(1, 12):
        state[:, i] = 0.0
    for i in range(12, 17):
        state[:, i] = 0.0
    state[:, I["secsSinceAl"]] = -1.0
    state[:, I["oneShotDone"]] = 0.0

    disc[:, D["V1"]] = 0.0
    disc[:, D["V2"]] = 0.0
    disc[:, D["V3"]] = 0.0
    disc[:, D["V4"]] = 1.0
    disc[:, D["PUMP"]] = 0.0
    disc[:, D["LAH"]] = 0.0 if "LAH" in isolated else 1.0
    disc[:, D["PIS"]] = 0.0 if "PIS" in isolated else 1.0
    disc[:, D["RACK"]] = 1.0
    disc[:, D["STOP"]] = 0.0
    disc[:, D["PISFAIL"]] = 0.0
    disc[:, D["gaugeBias"]] = bias
    disc[:, D["scale"]] = 1.0
    disc[:, D["V3LEAK"]] = 0.0
    disc[:, D["BUND_HEADROOM"]] = 1.0
    disc[:, D["BOND_OK"]] = 1.0
    disc[:, D["HAMMER"]] = 0.0
    disc[:, D["HOSE_SPILL"]] = 0.0
    # an independent hard-wired stop that a permit cannot leave isolated, so it
    # is a property of the configuration rather than something a step can spoil
    disc[:, D["AUTO_TRIP"]] = 1.0 if prot.get("autoTrip") is True else 0.0

    if "V4" in isolated:
        disc[:, D["V4"]] = 0.0
    prot = protection or {}
    if prot.get("pis") is False:
        disc[:, D["PIS"]] = 0.0
    if prot.get("lah") is False:
        disc[:, D["LAH"]] = 0.0


def advance(
    state: torch.Tensor,
    disc: torch.Tensor,
    params: dict[str, float],
    dt: float,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Advance the whole batch by `dt` seconds. Mutates and returns the inputs.

    Statement order follows the reference rather than the algebra, because two
    of the updates read values the previous line just wrote: the tick that
    bursts the line also leaks on the same tick, and the tick that latches the
    high level alarm starts counting alarm lead time on that same tick.
    """
    p = params
    s, d = state, disc
    # one code path for a fixed step and a per-scenario one: the batched kernel
    # integrates rows that are waiting with dt = 0
    if not isinstance(dt, torch.Tensor):
        dt = torch.full((state.shape[0],), float(dt), dtype=torch.float64, device=state.device)

    pump = d[:, D["PUMP"]] * (1.0 - d[:, D["STOP"]])
    v1 = d[:, D["V1"]]
    v2 = d[:, D["V2"]]
    v3 = d[:, D["V3"]]
    v4 = d[:, D["V4"]]
    q = pump * (p["qPump"] / 3600.0) * d[:, D["scale"]]

    to_tank = q * v1 * (1.0 - p["crossFrac"] * v3)
    to_cross = q * v1 * p["crossFrac"] * v3
    # the draw-off only flows while there is something to draw
    out_of = v2 * (p["qOut"] / 3600.0) * torch.where(s[:, I["level"]] > 0.05, 1.0, 0.0)
    deadhead = pump * (1.0 - v1)

    # an unseated cross-connect keeps feeding the tank from the header even
    # after the pump stops: the mechanism that turns a correct shutdown into an
    # overfill
    weep = d[:, D["V3LEAK"]] * (p["weepQ"] / 3600.0)
    lvl = s[:, I["level"]] + ((to_tank + weep - out_of) / p["area"]) * dt
    lvl = torch.clamp(lvl, min=0.0)
    s[:, I["level"]] = lvl
    s[:, I["diverted"]] = s[:, I["diverted"]] + (to_cross + out_of) * dt

    target = torch.where(
        pump == 0, 0.0, torch.where(deadhead == 1, float(p["pDead"]), float(p["pRun"]))
    )
    # torch.clamp rather than python min/max so `dt` may be a per-scenario tensor
    s[:, I["lineP"]] = s[:, I["lineP"]] + (target - s[:, I["lineP"]]) * torch.clamp(
        dt / p["tauP"], 0.0, 1.0
    )
    s[:, I["peakLineP"]] = torch.maximum(s[:, I["peakLineP"]], s[:, I["lineP"]])

    s[:, I["stress"]] = s[:, I["stress"]] + torch.where(s[:, I["lineP"]] > p["pRating"], dt, 0.0)

    burst = (s[:, I["stress"]] > p["stressFail"]) & (s[:, I["lineFailed"]] == 0)
    s[:, I["lineFailed"]] = torch.where(burst, 1.0, s[:, I["lineFailed"]])
    s[:, I["spill"]] = s[:, I["spill"]] + torch.where(burst, float(p["burstM3"]), 0.0)
    s[:, I["lineP"]] = torch.where(burst, 4.0, s[:, I["lineP"]])

    leak = s[:, I["lineFailed"]] * pump * (p["leakQ"] / 3600.0) * dt

    space = torch.clamp((p["hOverflow"] - lvl) * p["area"], min=0.5, max=1e6)
    compress = torch.where(
        (v4 == 0) & (to_tank > 0), (to_tank / space) * p["pRoof"] * dt, 0.0
    )
    vent_relief = (0.0 - s[:, I["tankP"]]) * torch.clamp(dt / p["tauVent"], 0.0, 1.0)
    s[:, I["tankP"]] = s[:, I["tankP"]] + torch.where(v4 == 0, compress, vent_relief)

    roof = (s[:, I["tankP"]] > p["pRoof"]) & (s[:, I["roofFailed"]] == 0)
    s[:, I["roofFailed"]] = torch.where(roof, 1.0, s[:, I["roofFailed"]])
    s[:, I["spill"]] = s[:, I["spill"]] + torch.where(roof, float(p["roofBurstM3"]), 0.0)
    s[:, I["tankP"]] = torch.where(roof, 0.0, s[:, I["tankP"]])
    roof_leak = s[:, I["roofFailed"]] * to_tank * dt

    above = torch.where(s[:, I["level"]] > p["hOverflow"], 1.0, 0.0)
    s[:, I["overflowed"]] = torch.where(above == 1, 1.0, s[:, I["overflowed"]])
    over_spill = above * to_tank * dt

    # one-shot releases tied to a specific field action. Gated on the tick having
    # actually elapsed: the batched kernel advances rows that are waiting at dt = 0,
    # and a release that does not depend on dt would otherwise fire early for a
    # scenario that is not on this tick in the reference.
    ticking = dt > 0 if isinstance(dt, torch.Tensor) else True
    armed = (
        (s[:, I["oneShotDone"]] == 0)
        & ((d[:, D["HAMMER"]] + d[:, D["HOSE_SPILL"]]) > 0)
        & ticking
    )
    one_shot = torch.where(
        armed,
        torch.where(d[:, D["HAMMER"]] == 1, float(p["hammerM3"]), 0.0)
        + torch.where(d[:, D["HOSE_SPILL"]] == 1, float(p["hoseM3"]), 0.0),
        0.0,
    )
    s[:, I["oneShotDone"]] = torch.where(one_shot > 0, 1.0, s[:, I["oneShotDone"]])

    s[:, I["spill"]] = s[:, I["spill"]] + leak + roof_leak + over_spill + one_shot
    s[:, I["delivered"]] = s[:, I["delivered"]] + to_tank * dt
    s[:, I["pumpTime"]] = s[:, I["pumpTime"]] + pump * dt
    s[:, I["t"]] = s[:, I["t"]] + dt

    want = leak + roof_leak + over_spill + one_shot
    capacity = p["bundCap"] * torch.where(d[:, D["BUND_HEADROOM"]] > 0, d[:, D["BUND_HEADROOM"]], 1.0)
    room = capacity - s[:, I["bund"]]
    retained = torch.where(want < room, want, room)
    s[:, I["bund"]] = s[:, I["bund"]] + retained
    s[:, I["escaped"]] = s[:, I["escaped"]] + (want - retained)

    latched = (s[:, I["level"]] >= p["hAl"]) & (d[:, D["LAH"]] == 1) & (s[:, I["lahLatched"]] == 0)
    new_lah = torch.where(latched, 1.0, s[:, I["lahLatched"]])
    secs = torch.where(latched, 0.0, s[:, I["secsSinceAl"]])
    # read the latch this tick wrote, so alarm lead time starts at dt and not 0
    counting = (new_lah == 1) & (secs >= 0)
    s[:, I["lahLatched"]] = new_lah
    s[:, I["secsSinceAl"]] = torch.where(counting, secs + dt, secs)

    tripped = (s[:, I["level"]] >= p["hAh"]) & (s[:, I["ahLatched"]] == 0)
    # the independent switch and the hard-wired auto trip are alternative means
    # of acting on the same demand, so either one stops the transfer
    acts = d[:, D["PIS"]] * (1.0 - d[:, D["PISFAIL"]]) + d[:, D["AUTO_TRIP"]]
    s[:, I["ahLatched"]] = torch.where(tripped, 1.0, s[:, I["ahLatched"]])
    d[:, D["STOP"]] = torch.where(tripped & (acts >= 1), 1.0, d[:, D["STOP"]])

    return state, disc


def indication(state: torch.Tensor, disc: torch.Tensor, name: str) -> torch.Tensor:
    """What the operator's gauge actually reads, bias and all."""
    i = var_index(name)
    if name == "level":
        return state[:, i] + disc[:, D["gaugeBias"]]
    if i < 0:
        return torch.zeros(state.shape[0], dtype=torch.float64, device=state.device)
    return state[:, i]


def magnitudes(state: torch.Tensor, disc: torch.Tensor, params: dict[str, float] | None = None) -> dict[str, torch.Tensor]:
    """Physical magnitudes per scenario; the economics layer turns these into money."""
    p = params or PARAMS
    batch, device = state.shape[0], state.device
    const = lambda v: torch.full((batch,), float(v), dtype=torch.float64, device=device)  # noqa: E731
    return {
        "releaseM3": state[:, I["spill"]],
        "containedM3": state[:, I["bund"]],
        "escapedM3": state[:, I["escaped"]],
        "divertedM3": state[:, I["diverted"]],
        "deliveredM3": state[:, I["delivered"]],
        "peakLineBar": state[:, I["peakLineP"]],
        "peakTankMbar": state[:, I["tankP"]],
        "pumpRunMin": state[:, I["pumpTime"]] / 60.0,
        "shiftMin": state[:, I["t"]] / 60.0,
        "alarmLeadS": state[:, I["secsSinceAl"]],
        "roofFailed": state[:, I["roofFailed"]],
        "lineFailed": state[:, I["lineFailed"]],
        "overflowed": state[:, I["overflowed"]],
        "pisDemand": state[:, I["ahLatched"]],
        "batchShortfallM3": torch.clamp(p["batchM3"] - state[:, I["delivered"]], min=0.0),
        "bondOk": disc[:, D["BOND_OK"]],
        "weepM3h": torch.where(disc[:, D["V3LEAK"]] > 0, const(p["weepQ"]), const(0.0)),
        "bundCapacityM3": p["bundCap"] * torch.where(disc[:, D["BUND_HEADROOM"]] > 0, disc[:, D["BUND_HEADROOM"]], 1.0),
        "rt2AvailableS": const((p["hAh"] - p["hAl"]) * p["area"] / (p["qPump"] / 3600.0)),
        "rt3AvailableS": const((p["hOverflow"] - p["hAh"]) * p["area"] / (p["qPump"] / 3600.0)),
        "responseRequiredS": const(p["walkS"] + p["actS"]),
    }


def classify_codes(state: torch.Tensor, disc: torch.Tensor, params: dict[str, float] | None = None) -> torch.Tensor:
    """Outcome class as an int64 code, first match wins, in `classify`'s order."""
    p = params or PARAMS
    batch, device = state.shape[0], state.device

    delivered = state[:, I["delivered"]]
    rules = [
        ("tank_breach", state[:, I["roofFailed"]] == 1),
        ("line_failure", state[:, I["lineFailed"]] == 1),
        ("overfill", state[:, I["overflowed"]] == 1),
        ("containment_escape", state[:, I["escaped"]] > 0.05),
        ("misrouting", state[:, I["diverted"]] > p["batchM3"] * 0.2),
        ("minor_release", state[:, I["spill"]] > 0.05),
        ("trip_stop", (disc[:, D["STOP"]] == 1) & (state[:, I["ahLatched"]] == 1) & (delivered < p["batchM3"] * 0.95)),
        ("no_flow", delivered < p["batchM3"] * 0.5),
        ("short_batch", delivered < p["batchM3"] * 0.9),
    ]

    normal = _CLASS_CODE["normal"]
    code = torch.full((batch,), normal, dtype=torch.int64, device=device)
    decided = torch.zeros(batch, dtype=torch.bool, device=device)
    for name, mask in rules:
        hit = mask & ~decided
        code = torch.where(hit, torch.full_like(code, _CLASS_CODE[name]), code)
        decided = decided | hit
    return code


def outcome_name(code: int) -> str:
    return OUTCOME_CLASSES[int(code)]


def outcome_names(codes: torch.Tensor) -> list[str]:
    return [OUTCOME_CLASSES[int(c)] for c in codes.tolist()]
