"""Consequence economics, vectorised.

A port of `src/engine/economics.ts` for tensors. Money is kept in its own layer
so that a reviewer who disagrees with a price does not have to disagree with the
physics. Every unit rate comes from data/costs.json with its source string; the
numbers here are transcription, not invention.

The reference builds a list of costed items and only books one when it exceeds
0.5 euro, so the same threshold is applied per item here as a mask rather than
being folded into the sum.
"""

from __future__ import annotations

import torch


def _product(costs: dict, product: str) -> dict:
    return costs["products"].get(product) or costs["products"]["toluene"]


def cost_tank(
    outcome: torch.Tensor,
    mag: dict[str, torch.Tensor],
    product: str,
    costs: dict,
    classes: list[str],
) -> dict[str, torch.Tensor]:
    """Total euro cost and expected escalated loss per scenario.

    `outcome` holds indices into `classes`, the twin's own class list.
    """
    pr = _product(costs, product)
    term = costs["terminal"]
    fines = costs["fines"]
    esc = costs["escalation"]
    device = outcome.device

    release = mag["releaseM3"]
    contained = mag["containedM3"]
    escaped = mag["escapedM3"]
    diverted = mag["divertedM3"]

    rc = pr["recoveryContained"]
    lost = release - contained * rc - (release - contained - escaped) * rc
    released = release > 0

    def item(value: torch.Tensor, booked: torch.Tensor) -> torch.Tensor:
        # `add(label, eur)` in the reference only pushes an item above 0.5, and
        # several items are additionally gated by a condition
        return torch.where(released & booked & (value > 0.5), value, torch.zeros_like(value))

    total = torch.zeros_like(release)

    total = total + item(torch.clamp(lost, min=0.0) * pr["eurPerM3"], torch.ones_like(release))
    total = total + item(contained * (1 - rc) * term["cleanupPerContainedM3"], torch.ones_like(release))
    total = total + item(escaped * term["remediationPerEscapedM3"], torch.ones_like(release))

    reportable = (escaped > fines["reportableThresholdM3"]) | (release > fines["reportableThresholdM3"] * 4)
    total = total + item(
        torch.clamp(fines["fixedEur"] + escaped * fines["perEscapedM3Eur"], max=fines["capEur"]), reportable
    )
    total = total + item(
        torch.full_like(release, float(term["investigationFlatEur"])), reportable
    )

    # out-of-service hours by failure mechanism, in the order the ternary chain
    # reads them
    def is_class(name: str) -> torch.Tensor:
        return outcome == classes.index(name)

    out_hours = torch.where(
        is_class("tank_breach"),
        168.0,
        torch.where(
            is_class("overfill") | is_class("line_failure"),
            48.0,
            torch.where(is_class("containment_escape"), 72.0, 12.0),
        ),
    )
    total = total + item(out_hours * term["rackIdleEurPerHour"], torch.ones_like(release))

    total = total + torch.where(
        (diverted > 1) & (diverted * pr["eurPerM3"] * 0.35 + term["flushFlatEur"] > 0.5),
        diverted * pr["eurPerM3"] * 0.35 + term["flushFlatEur"],
        torch.zeros_like(release),
    )
    aborted = torch.where(
        is_class("no_flow"),
        float(term["abortedBatchEur"]),
        float(term["abortedBatchEur"]) * 0.6,
    )
    total = total + torch.where(
        (is_class("no_flow") | is_class("short_batch")) & (aborted > 0.5),
        aborted,
        torch.zeros_like(release),
    )
    detention = float(term["abortedBatchEur"]) * 0.4
    total = total + torch.where(is_class("trip_stop") & (detention > 0.5), detention, torch.zeros_like(release))

    by_class = esc["byClass"]
    fallback = torch.where(release > 0, float(esc["ignitionProbabilityPerEvent"]), 0.0)
    table = torch.tensor(
        [float(by_class.get(name, 0.0)) for name in classes], dtype=torch.float64, device=device
    )
    # an outcome the escalation table does not list falls back to the
    # unconditional ignition probability for a release, as the reference's `??`
    # does; the table is sparse for classes a given twin cannot produce
    missing = torch.zeros_like(release, dtype=torch.bool)
    for i, name in enumerate(classes):
        if name not in by_class:
            missing = missing | (outcome == i)
    prob = torch.where(missing, fallback, table[outcome])

    return {
        "totalEur": total,
        "escalationEur": prob * float(esc["catastrophicEur"]),
        "reportable": reportable,
    }
