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
    "poor_procedure": [("PRU", [2, 1, 1])],
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
    order: list[str],
) -> torch.Tensor:
    """Move each factor only in the error-prone direction.

    `conditions` maps a condition id to a per-scenario severity in 0..3, 0 being
    inactive. `order` is the insertion order of the reference's condition object
    and is preserved because the record keeps the first binding that improved a
    factor, not the last.
    """
    cur_mult = gather_mult(level, diagnosis=False)
    for cond in order:
        sev = conditions.get(cond)
        if sev is None or not BINDINGS.get(cond):
            continue
        # bind() clamps severity into 1..3 before choosing the row
        clamped = torch.clamp(torch.round(sev), min=1, max=3).to(torch.int64)
        for psf, at in BINDINGS[cond]:
            k = PSF_INDEX[psf]
            new_idx = torch.where(clamped == 1, torch.full_like(clamped, at[0]),
                                  torch.where(clamped == 2, torch.full_like(clamped, at[1]),
                                              torch.full_like(clamped, at[2])))
            table = ACTION[k].to(new_idx.device)
            new_mult = table[torch.clamp(new_idx, min=0, max=_WIDTH - 1)]
            active = sev > 0
            take = active & (new_mult > cur_mult[:, k])
            level[:, k] = torch.where(take, new_idx, level[:, k])
            severity[:, k] = torch.where(take, clamped, severity[:, k])
            cur_mult = gather_mult(level, diagnosis=False)
    return level, severity


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
    step: dict,
    epc_max: float = HEART_EPC_MAX,
) -> dict:
    """HEP for every scenario at once. `level`/`severity` are [B, N_PSFS]."""
    device = level.device
    batch = level.shape[0]
    nominal = nominal_for(method, dict(step) | {"insideProcedure": bool(step.get("applies"))}
                          if method == "therp" else dict(step), kind)
    idx = torch.clamp(level, min=0, max=_WIDTH - 1)
    psf_rows = torch.arange(N_PSFS, device=device, dtype=torch.int64).expand(batch, N_PSFS)

    mult = gather_mult(level, diagnosis=is_diagnosis(kind))
    unachievable = (FAILS.to(device)[psf_rows, idx] == 1).any(dim=1) if method == "sparh" else None

    if method == "heart":
        apoa_idx = torch.clamp(torch.round(severity).to(torch.int64), min=1, max=4)
        apoa_table = torch.tensor(APOA_BY_LEVEL, dtype=torch.float64, device=device)
        apoa = apoa_table[apoa_idx]
        f = torch.ones(batch, dtype=torch.float64, device=device)
        for k in range(N_PSFS):
            f = f * ((epc_max - 1) * apoa[:, k] + 1)
        p = torch.clamp(nominal * f, max=1.0)
        c = f
        adjusted = torch.zeros(batch, dtype=torch.bool, device=device)
    else:
        c = torch.ones(batch, dtype=torch.float64, device=device)
        for k in range(N_PSFS):
            c = c * mult[:, k]
        negatives = (mult > 1).sum(dim=1)
        use_adj = (negatives >= 3) & (c > 1)
        raw = nominal * c
        p = torch.where(use_adj, spar_adjustment(nominal, c), raw)
        if method == "sparh":
            p = torch.clamp(torch.clamp(p, max=0.98), min=SPAR_FLOOR)
        else:
            p = torch.clamp(p, max=0.98)
        adjusted = use_adj

    if method == "sparh":
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


def detection_probability(level: torch.Tensor, severity: torch.Tensor, method: str, kind: str, step: dict) -> torch.Tensor:
    """How likely an independent check is to spot a deviation that is present.

    Modelled as an action in its own right, so "get it checked" is only ever as
    good as the checker.
    """
    miss = compute_hep(level, severity, method, kind, step)
    return torch.clamp(1.0 - miss["p"], min=0.05, max=0.999)


def level_labels(level: torch.Tensor, method: str, severity: torch.Tensor, epc_max: float = HEART_EPC_MAX) -> list[list[str]]:
    """`PSF:level name:multiplier` per scenario, for the fixture's audit trail."""
    mult = gather_mult(level, diagnosis=False)
    out: list[list[str]] = []
    cpu = level.cpu()
    if method == "heart":
        sev = severity.cpu()
        for b in range(cpu.shape[0]):
            row = []
            for k in range(N_PSFS):
                apoa = APOA_BY_LEVEL[min(4, max(1, int(round(float(sev[b, k])))))]
                row.append(f"{PSF_ORDER[k]}:EPC at APOA {apoa:.2f}:{(epc_max - 1) * apoa + 1}")
            out.append(row)
        return out
    names = cpu.tolist()
    mults = mult.cpu().tolist()
    for b in range(len(names)):
        out.append(
            [
                f"{PSF_ORDER[k]}:{SPAR_PSFS[PSF_ORDER[k]][min(names[b][k], len(SPAR_PSFS[PSF_ORDER[k]]) - 1)][0]}:{mults[b][k]}"
                for k in range(N_PSFS)
            ]
        )
    return out
