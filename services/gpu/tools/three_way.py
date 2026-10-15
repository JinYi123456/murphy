"""Scratch: three-way agreement - fixture, current reference engine, tensor kernel.

The golden fixture is a snapshot of the reference at generation time; the repo is
under active edit, so a disagreement has to be attributed before it is fixed.
Not part of the deliverable.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch  # noqa: E402

from murphy_gpu import kernel, tank  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data"
fx = json.load(open(DATA / "golden" / "shifts.json", encoding="utf-8"))
ref = json.load(open(Path(__file__).parent / "tmp" / "all_ref.json", encoding="utf-8"))
proc = json.load(open(DATA / "procedures" / "OP-TRF-014.json", encoding="utf-8"))
personas = {p["id"]: p for p in json.load(open(DATA / "personas.json", encoding="utf-8"))}
plants = {p["id"]: p for p in json.load(open(DATA / "plants.json", encoding="utf-8"))
          if p.get("twin") == "tank_transfer"}
costs = json.load(open(DATA / "costs.json", encoding="utf-8"))

R = {(r["plant"], r["persona"], r["method"], r["scn"]): r for r in ref}
groups = defaultdict(list)
for r in fx:
    groups[(r["plant"], r["persona"], r["method"], r["seed"])].append(r)

stats = defaultdict(lambda: defaultdict(int))
per_group = defaultdict(lambda: [0, 0, 0])
for (plant_id, persona_id, method, seed), rows in sorted(groups.items()):
    rows = sorted(rows, key=lambda r: r["scn"])
    out = kernel.run_shifts(proc, personas[persona_id], plants[plant_id], method, seed,
                           len(rows), torch.device("cpu"), costs)
    gk = (plant_id, persona_id, method)
    for i, exp in enumerate(rows):
        got_cls = tank.OUTCOME_CLASSES[int(out.outcome[i])]
        got_el = float(out.elapsed[i])
        got_cost = float(out.cost[i])
        r_ = R[(plant_id, persona_id, method, exp["scn"])]
        stats[gk]["n"] += 1
        per_group[gk][0] += 1
        if got_cls == exp["outcome"]:
            stats[gk]["py_fx_class"] += 1
        if abs(got_el - exp["elapsedS"]) <= 1e-3:
            stats[gk]["py_fx_el"] += 1
        if abs(got_cost - exp["costEur"]) <= 1e-6 * max(1.0, abs(exp["costEur"])):
            stats[gk]["py_fx_cost"] += 1
        if got_cls == r_["outcome"]:
            stats[gk]["py_ref_class"] += 1
        if abs(got_el - r_["elapsedS"]) <= 1e-3:
            stats[gk]["py_ref_el"] += 1
        if abs(got_cost - r_["costEur"]) <= 2e-3 * max(1.0, abs(r_["costEur"])):
            stats[gk]["py_ref_cost"] += 1
        if r_["outcome"] == exp["outcome"]:
            stats[gk]["ref_fx_class"] += 1
        if abs(r_["elapsedS"] - exp["elapsedS"]) <= 1e-3:
            stats[gk]["ref_fx_el"] += 1

tot = defaultdict(int)
for gk, s in stats.items():
    for k, v in s.items():
        tot[k] += v if k != "n" else 0
print("group-level (only groups that are not fully consistent):")
for gk, s in sorted(stats.items()):
    bad = s["py_ref_class"] != s["n"] or s["py_ref_el"] != s["n"] or s["ref_fx_class"] != s["n"]
    if bad:
        print("  ", gk, dict(s))
print()
print("TOTALS:", dict(tot), "rows", sum(per_group[g][0] for g in per_group))
