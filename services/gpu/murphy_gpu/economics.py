"""Consequence economics, vectorised.

A port of `src/engine/economics.ts` for tensors. Money is kept in its own layer
so that a reviewer who disagrees with a price does not have to disagree with the
physics. Every unit rate is transcribed from data/costs.json with its source
string; nothing here is invented.

The reference builds a list of costed items and only books one when it exceeds
0.5 euro, so that threshold is applied per item as a mask rather than folded into
the sum - which matters, because a small release then costs nothing at all rather
than something rounded to zero.
"""

from __future__ import annotations

import torch


def cost_tank(
    outcome: torch.Tensor,
    mag: dict[str, torch.Tensor],
    product: str,
    costs: dict,
    classes: list[str],
) -> dict[str, torch.Tensor]:
    """Total euro cost and expected escalated loss per scenario.

    `outcome` holds indices into `classes`, the twin's own outcome list.
    """
    pr = costs["products"].get(product) or costs["products"]["toluene"]
    term = costs["terminal"]
    fines = costs["fines"]
    esc = costs["escalation"]
    device = outcome.device

    release = mag["releaseM3"]
    contained = mag["containedM3"]
    escaped = mag["escapedM3"]
    diverted = mag["divertedM3"]
    zero = torch.zeros_like(release)
    ones = torch.ones_like(release)

    def full(value: float) -> torch.Tensor:
        return ones * float(value)

    def is_class(name: str) -> torch.Tensor:
        return outcome == classes.index(name)

    def booked(value: torch.Tensor, condition: torch.Tensor) -> torch.Tensor:
        return torch.where(condition & (value > 0.5), value, zero)

    rc = pr["recoveryContained"]
    # the lost volume is what neither the vacuum truck nor the remediation crew
    # gets back; the reference's formula is transcribed, not improved
    lost = release - contained * rc - (release - contained - escaped) * rc
    released = release > 0

    total = booked(torch.clamp(lost, min=0.0) * pr["eurPerM3"], released)
    total = total + booked(contained * (1 - rc) * term["cleanupPerContainedM3"], released)
    total = total + booked(escaped * term["remediationPerEscapedM3"], released)

    reportable = (escaped > fines["reportableThresholdM3"]) | (release > fines["reportableThresholdM3"] * 4)
    total = total + booked(
        torch.clamp(full(fines["fixedEur"]) + escaped * fines["perEscapedM3Eur"], max=fines["capEur"]),
        released & reportable,
    )
    total = total + booked(full(term["investigationFlatEur"]), released & reportable)

    out_hours = torch.where(
        is_class("tank_breach"),
        full(168),
        torch.where(
            is_class("overfill") | is_class("line_failure"),
            full(48),
            torch.where(is_class("containment_escape"), full(72), full(12)),
        ),
    )
    total = total + booked(out_hours * term["rackIdleEurPerHour"], released)

    total = total + booked(diverted * pr["eurPerM3"] * 0.35 + full(term["flushFlatEur"]), diverted > 1)

    aborted = full(term["abortedBatchEur"]) * torch.where(is_class("no_flow"), ones, ones * 0.6)
    total = total + booked(aborted, is_class("no_flow") | is_class("short_batch"))
    total = total + booked(full(term["abortedBatchEur"] * 0.4), is_class("trip_stop"))

    # expected loss if the event escalates, reported separately from booked cost
    by_class = esc["byClass"]
    table = torch.tensor(
        [float(by_class.get(name, 0.0)) for name in classes], dtype=torch.float64, device=device
    )
    fallback = torch.where(released, full(esc["ignitionProbabilityPerEvent"]), zero)
    missing = torch.zeros_like(released)
    for i, name in enumerate(classes):
        if name not in by_class:
            missing = missing | is_class(name)
    prob = torch.where(missing, fallback, table[outcome])

    return {
        "totalEur": total,
        "escalationEur": prob * float(esc["catastrophicEur"]),
        "reportable": reportable,
    }
