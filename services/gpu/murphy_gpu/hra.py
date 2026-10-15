"""Vectorised human reliability layer: SPAR-H, THERP and HEART, one interface.

Tables are transcribed from the same primary sources the TypeScript cites
(NUREG/CR-6883 for SPAR-H, NUREG/CR-1278 Appendix G for THERP, HSE RR679 for
HEART). Nothing here invents a rate.

Two rules from the method are load-bearing and are implemented exactly, because
they are what keeps the numbers sane:

  * the SPAR-H adjustment factor, a saturating transform used instead of the raw
    product whenever three or more shaping factors act in the error-prone
    direction;
  * at most three negative PSFs may act on a step - the strongest three - since
    "fatigued", "rushed" and "poor procedure" are three descriptions of one
    situation and multiplying all three re-counts the same cause.

Everything is tensor-shaped: the per-scenario PSF level selection goes in as
int64 [B, 8] and the HEP comes out as [B, nSteps] or [B].
"""

from __future__ import annotations

import torch

PSF_ORDER = ["AVL", "STR", "CX", "E-T", "PRU", "HCI", "FFD", "WMP"]
PSF_INDEX = {p: i for i, p in enumerate(PSF_ORDER)}
N_PSFS = len(PSF_ORDER)

# (level name, action multiplier, diagnosis multiplier or None, fails)
SPAR_PSFS: dict[str, list[tuple[str, float, float | None, bool]]] = {
    "AVL": [
        ("inadequate time", 1, None, True),
        ("less than time required", 10, None, False),
        ("time required or less than nominal", 1, None, False),
        ("5 times the nominal time", 0.1, None, False),
        ("50 times the nominal time", 0.01, None, False),
    ],
    "STR": [
        ("extreme", 5, None, False),
        ("high", 2, None, False),
        ("low to nominal", 1, None, False),
        ("low", 0.5, None, False),
    ],
    "CX": [
        ("very complex", 10, None, False),
        ("high", 5, None, False),
        ("moderate", 2, None, False),
        ("easy", 1, None, False),
        ("obvious", 0.1, None, False),
    ],
    "E-T": [
        ("low or none", 10, 10, False),
        ("below average", 5, None, False),
        ("average", 2, None, False),
        ("above average", 1, None, False),
        ("expert", 0.5, None, False),
    ],
    "PRU": [
        ("not available", 50, None, False),
        ("incomplete", 20, None, False),
        ("poor", 5, None, False),
        ("unused where available", 1, None, False),
        ("good", 0.5, None, False),
    ],
    "HCI": [
        ("missing or misleading", 50, None, False),
        ("poor", 10, None, False),
        ("adequate", 2, None, False),
        ("good", 1, None, False),
        ("excellent", 0.5, None, False),
    ],
    "FFD": [
        ("unfit", 1, None, True),
        ("degraded", 5, None, False),
        ("average", 1, None, False),
        ("excellent", 0.1, None, False),
    ],
    "WMP": [
        ("inadequate or poor", 5, None, False),
        ("defined but not used", 1, None, False),
        ("good or robust", 0.8, None, False),
    ],
}

SPAR_NOMINAL = {"action": 1e-3, "diagnosis": 1e-2}
SPAR_FLOOR = 1e-5

THERP_BASE: dict[str, float] = {
    "wrong_key_switch": 1e-4,
    "dissimilar_switch": 1e-3,
    "commission_label": 3e-3,
    "omission_no_display": 1e-2,
    "omission_in_procedure": 3e-3,
    "omission_outside_procedure": 1e-2,
    "arithmetic_self_check": 3e-2,
    "note_already_positioned": 1e-1,
    "monitor_misses_error": 1e-1,
    "different_shift_no_check": 1e-1,
    "walk_around_miss": 5e-1,
    "first_60s_extreme_stress": 1.0,
    "five_min_extreme_stress": 0.9,
    "thirty_min_stress": 1e-1,
    "hours_recovery": 1e-2,
    "general_first_estimate": 3e-3,
}

THERP_ERROR_FACTOR = 10

HEART_GTT: dict[str, float] = {
    "A": 0.55,
    "B": 0.26,
    "C": 0.16,
    "D": 0.09,
    "M": 0.03,
    "E": 0.02,
    "F": 0.003,
    "G": 0.0004,
    "H": 0.00002,
}

HEART_EPC_MAX = 30
APOA_BY_LEVEL = [0, 0.25, 0.5, 0.75, 1.0]

DEFAULT_GTT = {
    "actuate": "G",
    "verify": "F",
    "authorise": "E",
    "communicate": "M",
    "monitor": "D",
    "recover": "C",
}

# Conditions the wording of a generic task type already contains. RR679 requires
# the analyst not to charge the same feature twice: type B is 0.26 *because* the
# job is being done without written procedures, so a "procedures inadequate" EPC
# on top of it is the same defect counted a second time and multiplied. Only the
# overlaps the published wording names outright are listed.
GTT_EMBEDDED = {
    "A": ("CX", "E-T"),
    "B": ("PRU",),
    "C": ("CX",),
    "D": ("CX", "E-T"),
    "E": ("HCI",),
    "F": ("PRU",),
    "G": ("CX", "E-T", "HCI", "PRU"),
    "H": (),
    "M": ("HCI",),
}


def resolve_gtt(kind: str, gtt: str | None) -> str:
    return gtt if gtt else DEFAULT_GTT[kind]


def heart_epc(level, severity, kind: str, gtt: str | None, epc_max: float = HEART_EPC_MAX):
    """Which PSF columns are genuine error producing conditions, and how hard.

    Returns (own, apoa, counts). A column counts only when the condition is
    actually present, its published level is worse than unity, and the generic
    task type has not already priced it in.
    """
    device = level.device
    g = resolve_gtt(kind, gtt)
    embedded = torch.tensor(
        [1 if p in GTT_EMBEDDED.get(g, ()) else 0 for p in PSF_ORDER],
        dtype=torch.bool, device=device,
    )
    strength = gather_mult(level, diagnosis=is_diagnosis(kind))
    own = torch.clamp(strength, min=1.2, max=epc_max)
    apoa_idx = torch.round(severity).to(torch.int64).clamp(min=0, max=len(APOA_BY_LEVEL) - 1)
    apoa = torch.tensor(APOA_BY_LEVEL, dtype=torch.float64, device=device)[apoa_idx]
    counts = (severity >= 1) & (strength > 1) & (~embedded).expand_as(strength)
    return own, apoa, counts


MAX_NEGATIVE_PSFS = 3

PROTECTION_FOD = {
    "soft_alarm": 0.1,
    "independent_switch": 0.01,
    "independent_switch_proven": 0.001,
    "interlock": 0.01,
    "operator_response": 0.1,
    "containment": 0.02,
}

# condition -> [(psf, [level index at severity 1, 2, 3]), ...]
BINDINGS: dict[str, list[tuple[str, list[int]]]] = {
    "novel_task": [("CX", [3, 2, 1]), ("E-T", [2, 1, 0])],
    "low_experience": [("E-T", [2, 1, 0])],
    "confusable_device": [("HCI", [2, 1, 1])],
    "ambiguous_wording": [("PRU", [3, 2, 1])],
    "memory_load": [("HCI", [2, 1, 0])],
    "poor_procedure": [("PRU", [2, 2, 1])],
    "timing_critical": [("AVL", [2, 1, 1])],
    "time_pressure": [("AVL", [2, 1, 1]), ("STR", [2, 1, 0])],
    "distraction": [("STR", [2, 1, 0])],
    "interruption": [("STR", [2, 1, 1])],
    "fatigue": [("FFD", [2, 1, 1])],
    "teamwork": [("WMP", [1, 0, 0])],
    "mistrust": [("WMP", [1, 0, 0]), ("STR", [2, 1, 1])],
    "unprepared_exception": [("CX", [3, 2, 1])],
    "situation_awareness": [("CX", [2, 2, 1]), ("STR", [2, 1, 1])],
    "post_maintenance_state": [("WMP", [0, 0, 0]), ("HCI", [2, 2, 1])],
    "language_barrier": [("PRU", [2, 2, 1])],
    "incomplete_function_test": [("WMP", [1, 0, 0])],
    "absent_cue": [("HCI", [2, 1, 1])],
}

CUE_LEVELS = {
    "gauge": 3, "light": 3, "checklist": 3, "physical": 3,
    "label": 2, "document": 2, "verbal": 1, "memory": 1,
}

# Padded to a rectangular table so a level index can be gathered on the GPU
# without a python branch per scenario. -1 marks "no diagnosis override".
_ACTION = [[float(l[1]) for l in SPAR_PSFS[p]] for p in PSF_ORDER]
_DIAG = [[(float(l[2]) if l[2] is not None else -1.0) for l in SPAR_PSFS[p]] for p in PSF_ORDER]
_FAILS = [[1.0 if l[3] else 0.0 for l in SPAR_PSFS[p]] for p in PSF_ORDER]
_WIDTH = max(len(v) for v in _ACTION)


def _padded(rows: list[list[float]], pad: float) -> torch.Tensor:
    out = torch.full((N_PSFS, _WIDTH), pad, dtype=torch.float64)
    for i, row in enumerate(rows):
        out[i, : len(row)] = torch.tensor(row, dtype=torch.float64)
    return out


ACTION = _padded(_ACTION, 1.0)
DIAGNOSIS = _padded(_DIAG, -1.0)
FAILS = _padded(_FAILS, 0.0)

NOMINAL_INDEX = torch.tensor(
    [
        next(i for i, lv in enumerate(SPAR_PSFS[p]) if lv[1] == 1 and not lv[3])
        for p in PSF_ORDER
    ],
    dtype=torch.int64,
)
MAX_LEVEL = torch.tensor([len(SPAR_PSFS[p]) - 1 for p in PSF_ORDER], dtype=torch.int64)


def is_diagnosis(kind: str) -> bool:
    """SPAR-H reserves the diagnosis rate for establishing the state of a system.

    An emergency stop stays on the action rate even though recognising when to
    press it is hard, because pressing it is a trained motor action.
    """
    return kind == "verify"


def gather_mult(level: torch.Tensor, diagnosis: bool) -> torch.Tensor:
    """Multiplier [B, N_PSFS] for a level selection [B, N_PSFS]."""
    idx = torch.clamp(level, min=0, max=_WIDTH - 1)
    table = DIAGNOSIS if diagnosis else ACTION
    psf = torch.arange(N_PSFS, device=idx.device, dtype=torch.int64).expand_as(idx)
    mult = table.to(idx.device)[psf, idx]
    if diagnosis:
        # a level without its own diagnosis figure falls back to the action one
        fallback = ACTION.to(idx.device)[psf, idx]
        mult = torch.where(mult < 0, fallback, mult)
    return mult


def baseline_levels(step: dict, persona: dict, plant: dict) -> list[int]:
    """The worksheet with nothing triggering: a trained crew, a clear procedure
    and a readable gauge is genuinely better than nominal, which is why the same
    procedure can be safe in one pair of hands and not in another."""
    kind = step["kind"]
    exp_y = float(persona["experienceY"])
    runs = float(persona["runsBefore"])
    current = bool(persona["qualificationCurrent"])
    if exp_y >= 8 and runs >= 100 and current:
        et = 4
    elif exp_y >= 4 and current:
        et = 3
    else:
        et = 2
    scripted = bool(step.get("applies") or step.get("verify") or step.get("watch"))
    return [
        2,
        2,
        3 if kind == "actuate" else 2,
        et,
        4 if scripted else 3,
        CUE_LEVELS[step["cue"]],
        2,
        2 if (bool(plant["provenRecent"]) and float(persona["teamReadiness"]) >= 0.8) else 1,
    ]


def apply_conditions(
    level: torch.Tensor,
    severity: torch.Tensor,
    conditions: dict[str, torch.Tensor],
) -> None:
    """Move each factor only in the error-prone direction.

    `conditions` maps a condition id to a per-scenario severity in 0..3, 0 being
    inactive, and is walked in the reference's insertion order because the
    worksheet keeps the first binding that improved a factor, not the last.
    """
    cur_mult = gather_mult(level, diagnosis=False)
    for cond, sev in conditions.items():
        bindings = BINDINGS.get(cond)
        if not bindings:
            continue
        # bind() clamps severity into 1..3 before choosing the row
        clamped = torch.clamp(torch.round(sev), min=1, max=3).to(torch.int64)
        active = sev > 0
        for psf, at in bindings:
            k = PSF_INDEX[psf]
            new_idx = torch.where(
                clamped == 1,
                torch.full_like(clamped, at[0]),
                torch.where(clamped == 2, torch.full_like(clamped, at[1]), torch.full_like(clamped, at[2])),
            )
            table = ACTION[k].to(new_idx.device)
            new_mult = table[torch.clamp(new_idx, min=0, max=_WIDTH - 1)]
            take = active & (new_mult > cur_mult[:, k])
            level[:, k] = torch.where(take, new_idx, level[:, k])
            severity[:, k] = torch.where(take, clamped, severity[:, k])
            cur_mult[:, k] = torch.where(take, new_mult, cur_mult[:, k])


class ConditionBag:
    """Ordered condition set: `add` keeps the strongest severity and the
    original position, exactly like the reference's `out[c] = max(...)`."""

    def __init__(self, batch: int, device) -> None:
        self.items: dict[str, torch.Tensor] = {}
        self.batch = batch
        self.device = device

    def add(self, cond: str, level) -> None:
        if isinstance(level, torch.Tensor):
            value = level.to(torch.int64)
        else:
            value = torch.full((self.batch,), int(level), dtype=torch.int64, device=self.device)
        if cond in self.items:
            self.items[cond] = torch.maximum(self.items[cond], value)
        else:
            self.items[cond] = value


def conditions_for(
    step: dict,
    persona: dict,
    plant: dict,
    ctx: dict,
    warnings: list[dict] | None = None,
    batch: int = 1,
    device=None,
) -> dict[str, torch.Tensor]:
    """Error producing conditions active for one performance of one step.

    Partly the analyst's annotation, partly the persona, partly earned by the
    shift so far: schedule slip and an alarm ringing mid-action are nowhere in
    the procedure. Cue quality is deliberately not injected as a condition here
    because it is already scored in the ergonomics row - counting it twice would
    double one cause.

    `ctx` carries the emergent state, either as a python scalar (a static
    worksheet, as the HEP fixture asks for) or as a [B] tensor (mid-shift, as the
    kernel does); both are normalised to tensors of the batch shape.
    """
    bag = ConditionBag(batch, device)
    zero = torch.zeros(batch, dtype=torch.int64, device=device)

    def level(value: int) -> torch.Tensor:
        return torch.full((batch,), int(value), dtype=torch.int64, device=device)

    def mask(value) -> torch.Tensor:
        if isinstance(value, torch.Tensor):
            return value.to(torch.bool).reshape(batch)
        return torch.full((batch,), bool(value), dtype=torch.bool, device=device)

    def number(value) -> torch.Tensor:
        if isinstance(value, torch.Tensor):
            return value.to(torch.float64).reshape(batch)
        return torch.full((batch,), float(value), dtype=torch.float64, device=device)

    for c in step.get("cond") or []:
        bag.add(c, 1)
    if step["cue"] == "verbal":
        bag.add("teamwork", 1)
    alarm_fatigued = bool((plant.get("protection") or {}).get("alarmFrequentFalse") is True)
    if step["cue"] == "light" and alarm_fatigued:
        bag.add("mistrust", 1)

    exp_y = float(persona["experienceY"])
    if exp_y < 1.5 or not persona["qualificationCurrent"]:
        bag.add("low_experience", 2)
    elif exp_y < 4 or float(persona["runsBefore"]) < 3:
        bag.add("low_experience", 1)
    if float(persona["hoursIntoShift"]) > 10 or float(persona["shiftStartHour"]) < 5:
        bag.add("fatigue", 2)
    elif float(persona["hoursIntoShift"]) > 8 or float(persona["shiftStartHour"]) < 7:
        bag.add("fatigue", 1)
    if float(persona["languageFriction"]) > 0.4:
        bag.add("language_barrier", 2)
    if float(persona["concurrency"]) >= 2:
        bag.add("distraction", 2)
    elif float(persona["concurrency"]) >= 1:
        bag.add("distraction", 1)
    if float(persona["teamReadiness"]) < 0.5:
        bag.add("teamwork", 2)
    elif float(persona["teamReadiness"]) < 0.8:
        bag.add("teamwork", 1)
    if float(persona["deadlinePressure"]) > 0.6:
        bag.add("time_pressure", 1)

    slip = number(ctx["slipRatio"])
    bag.add("time_pressure", torch.where(slip > 1.4, level(3), torch.where(slip > 1.2, level(2), torch.where(slip > 1.05, level(1), zero))))

    bag.add("situation_awareness", torch.where(mask(ctx["alarmRinging"]), level(2), zero))
    bag.add("unprepared_exception", torch.where(mask(ctx["hazardSeen"]), level(2), zero))

    # a permit that left something isolated is sampled per scenario; a plant that
    # starts the shift that way is a property of the configuration
    standing = mask(True) if (plant.get("preIsolated") or []) else mask(False)
    bag.add(
        "post_maintenance_state",
        torch.where(standing | mask(ctx["permitLeftSomethingIsolated"]), level(2), zero),
    )
    if not plant["provenRecent"]:
        bag.add("incomplete_function_test", 1)
    bag.add("mistrust", torch.where(number(ctx["instrumentDrift"]).abs() > 0.15, level(1), zero))
    if alarm_fatigued:
        bag.add("mistrust", 1)

    for w in warnings or []:
        if step["id"] in w["steps"]:
            bag.add(w["cond"], w["level"])

    return bag.items


def assess(
    step: dict,
    persona: dict,
    plant: dict,
    conditions: dict[str, torch.Tensor],
    batch: int,
    device=None,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Fill the shaping-factor worksheet for one performance of one step."""
    base = baseline_levels(step, persona, plant)
    level = torch.tensor(base, dtype=torch.int64, device=device).repeat(batch, 1)
    severity = torch.zeros(batch, N_PSFS, dtype=torch.int64, device=device)
    apply_conditions(level, severity, conditions)
    level, suppressed = limit_negative_psfs(level)
    return level, severity, suppressed


def limit_negative_psfs(level: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Cap the negative factors that may act on a step at three, the strongest.

    Suppressed factors are held at nominal rather than deleted so the worksheet
    still shows eight rows, and the suppressed mask is returned for the audit.
    """
    mult = gather_mult(level, diagnosis=False)
    negative = mult > 1
    # +inf sorts last; a stable sort then reproduces the reference's
    # "descending multiplier, ties in PSF order" selection
    score = torch.where(negative, -mult, torch.full_like(mult, float("inf")))
    _, order = torch.sort(score, dim=1, stable=True)
    keep = torch.zeros_like(negative)
    for j in range(MAX_NEGATIVE_PSFS):
        col = order[:, j : j + 1]
        worth = score.gather(1, col) < float("inf")
        keep = keep.scatter(1, col, worth.expand(-1, 1))
    suppressed = negative & ~keep
    held = torch.where(suppressed, NOMINAL_INDEX.to(level.device).expand_as(level), level)
    return held, suppressed


def nominal_for(
    method: str,
    kind: str,
    *,
    gtt: str | None = None,
    similarity: float | None = None,
    inside_procedure: bool = False,
) -> float:
    if method == "sparh":
        return SPAR_NOMINAL["diagnosis"] if is_diagnosis(kind) else SPAR_NOMINAL["action"]
    if method == "heart":
        return HEART_GTT[gtt if gtt else DEFAULT_GTT[kind]]
    sim = float(similarity or 1)
    if kind == "verify":
        return THERP_BASE["walk_around_miss"]
    if kind == "monitor":
        return THERP_BASE["monitor_misses_error"]
    if kind == "recover":
        return THERP_BASE["thirty_min_stress"]
    if kind == "actuate" and sim > 1:
        # the chance of picking wrong among n confusable devices rises with n
        return min(0.5, THERP_BASE["dissimilar_switch"] * ((sim - 1) / sim) * 4)
    if kind == "actuate":
        return THERP_BASE["commission_label"]
    if kind == "communicate":
        return THERP_BASE["arithmetic_self_check"]
    return (
        THERP_BASE["omission_in_procedure"]
        if inside_procedure
        else THERP_BASE["omission_outside_procedure"]
    )


def spar_adjustment(nominal: float, c: torch.Tensor) -> torch.Tensor:
    """HEP = NHEP*C / (1 + NHEP*(C-1)), the published saturating transform.

    This is why a badly shaped step lands near 0.8 instead of at 40.
    """
    return (nominal * c) / (1 + nominal * (c - 1))


def compute_hep(
    level: torch.Tensor,
    severity: torch.Tensor,
    method: str,
    kind: str,
    *,
    gtt: str | None = None,
    similarity: float | None = None,
    inside_procedure: bool = False,
    epc_max: float = HEART_EPC_MAX,
) -> dict:
    """HEP for every scenario at once. `level`/`severity` are [B, N_PSFS]."""
    device = level.device
    batch = level.shape[0]
    nominal = nominal_for(
        method, kind, gtt=gtt, similarity=similarity, inside_procedure=inside_procedure
    )
    idx = torch.clamp(level, min=0, max=_WIDTH - 1)
    psf_rows = torch.arange(N_PSFS, device=device, dtype=torch.int64).expand(batch, N_PSFS)

    mult = gather_mult(level, diagnosis=is_diagnosis(kind))
    unachievable = (FAILS.to(device)[psf_rows, idx] == 1).any(dim=1) if method == "sparh" else None

    if method == "heart":
        # HEART scales each error producing condition by its own maximum factor,
        # taken from the published 1.2 - 30 band, times its assumed probabilistic
        # impact on the task (APOA). Treating every condition as a x30 one is how
        # a method ends up reporting 100%.
        own, apoa, counts = heart_epc(level, severity, kind, gtt, epc_max)
        ep = torch.where(counts, (own - 1) * apoa + 1, torch.ones_like(own))
        f = ep.prod(dim=1)
        # RR679 caps at unity, which is not a probability of 1 but the method
        # saying the task is unachievable as shaped; the ceiling is reported at
        # the same 0.98 the other two methods use and the raw product stays
        # visible in the multiplier column.
        p = torch.clamp(nominal * f, max=0.98)
        c = f
        adjusted = torch.zeros(batch, dtype=torch.bool, device=device)
    else:
        c = torch.ones(batch, dtype=torch.float64, device=device)
        for k in range(N_PSFS):
            c = c * mult[:, k]
        negatives = (mult > 1).sum(dim=1)
        use_adj = (negatives >= 3) & (c > 1)
        p = torch.where(use_adj, spar_adjustment(nominal, c), nominal * c)
        if method == "sparh":
            p = torch.clamp(torch.clamp(p, max=0.98), min=SPAR_FLOOR)
        else:
            p = torch.clamp(p, max=0.98)
        adjusted = use_adj

    if method == "sparh":
        # a factor at its bottom level makes the action unachievable, so it is
        # scored as a failure rather than as a large multiplier
        p = torch.where(unachievable, torch.full_like(p, 0.99), p)
        c = torch.where(unachievable, torch.ones_like(c), c)
        adjusted = adjusted & ~unachievable

    ef = float(THERP_ERROR_FACTOR) if method == "therp" else (3.0 if method == "sparh" else 5.0)
    return {
        "p": p,
        "multiplier": c,
        "nominal": nominal,
        "lo": torch.clamp(p / ef, min=1e-6),
        "hi": torch.clamp(p * ef, max=0.99),
        "adjusted": adjusted,
        "rows": mult,
        "unachievable": unachievable if method == "sparh" else torch.zeros_like(adjusted),
    }


def detection_probability(
    level: torch.Tensor,
    severity: torch.Tensor,
    method: str,
    kind: str,
    *,
    gtt: str | None = None,
    similarity: float | None = None,
    inside_procedure: bool = True,
) -> torch.Tensor:
    """How likely an independent check is to spot a deviation that is present.

    Modelled as an action in its own right, so "get it checked" is only ever as
    good as the checker.
    """
    miss = compute_hep(
        level, severity, method, kind, gtt=gtt, similarity=similarity,
        inside_procedure=inside_procedure,
    )
    return torch.clamp(1.0 - miss["p"], min=0.05, max=0.999)


def js_number(x: float) -> str:
    """Format a double the way `String(number)` does in the reference.

    Only used for the audit strings the HEP fixture stores, so `1` has to come
    back as `1` and not `1.0` for a comparison to mean anything.
    """
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    return repr(float(x))


def level_labels(
    level: torch.Tensor, method: str, severity: torch.Tensor,
    kind: str = "actuate", gtt: str | None = None, epc_max: float = HEART_EPC_MAX,
) -> list[list[str]]:
    """`PSF:level name:multiplier` per scenario, for the fixture's audit trail.

    The heart branch has to reproduce the reference string for string: a row that
    is not an error producing condition keeps its level name and a factor of 1,
    and a suppressed one says which task type already priced it in.
    """
    mult = gather_mult(level, diagnosis=False)
    cpu = level.cpu()
    sev = severity.cpu()
    out: list[list[str]] = []
    if method == "heart":
        own_t, apoa_t, counts = heart_epc(level, severity, kind, gtt, epc_max)
        own_c = own_t.cpu().tolist()
        apoa_c = apoa_t.cpu().tolist()
        cnt_c = counts.cpu().tolist()
        names = cpu.tolist()
        g = resolve_gtt(kind, gtt)
        strength = gather_mult(level, diagnosis=is_diagnosis(kind)).cpu().tolist()
        for b in range(len(names)):
            row = []
            for k in range(N_PSFS):
                name = SPAR_PSFS[PSF_ORDER[k]][min(names[b][k], len(SPAR_PSFS[PSF_ORDER[k]]) - 1)][0]
                if not cnt_c[b][k]:
                    if sev[b][k] >= 1 and strength[b][k] > 1:
                        row.append(
                            f"{PSF_ORDER[k]}:{name} - already inside generic task type {g}, not charged again:1"
                        )
                    else:
                        row.append(f"{PSF_ORDER[k]}:{name}:1")
                    continue
                row.append(
                    f"{PSF_ORDER[k]}:{name} as EPC, max {own_c[b][k]:.1f} at APOA {apoa_c[b][k]:.2f}"
                    f":{js_number((own_c[b][k] - 1) * apoa_c[b][k] + 1)}"
                )
            out.append(row)
        return out
    names = cpu.tolist()
    mults = mult.cpu().tolist()
    for b in range(len(names)):
        out.append(
            [
                f"{PSF_ORDER[k]}:{SPAR_PSFS[PSF_ORDER[k]][min(names[b][k], len(SPAR_PSFS[PSF_ORDER[k]]) - 1)][0]}:{js_number(mults[b][k])}"
                for k in range(N_PSFS)
            ]
        )
    return out
