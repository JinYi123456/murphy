"""Scratch: attribute the tk_uprated disagreement to a plant-config edit.

The golden fixture predates the last edit of data/plants.json, so the question is
which single field of tk_uprated explains a disagreement that touches the physics
but leaves every error stream intact. The kernel is byte-for-byte the reference
here (see tools/three_way.py), so scanning it is a valid probe of the reference.
Not part of the deliverable.
"""
import itertools
import json
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch  # noqa: E402

from murphy_gpu import kernel, tank  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data"
fx = json.load(open(DATA / "golden" / "shifts.json", encoding="utf-8"))
proc = json.load(open(DATA / "procedures" / "OP-TRF-014.json", encoding="utf-8"))
personas = {p["id"]: p for p in json.load(open(DATA / "personas.json", encoding="utf-8"))}
plants = {p["id"]: p for p in json.load(open(DATA / "plants.json", encoding="utf-8"))}
costs = json.load(open(DATA / "costs.json", encoding="utf-8"))
base = plants["tk_uprated"]

rows = [r for r in fx if r["plant"] == "tk_uprated"]
per_group = {}
for r in rows:
    per_group.setdefault((r["persona"], r["method"]), []).append(r)
for k in per_group:
    per_group[k] = sorted(per_group[k], key=lambda r: r["scn"])[:20]


def score(plant, n=20):
    cls = el = co = 0
    tot = 0
    for (persona_id, method), rs in sorted(per_group.items()):
        rs = rs[:n]
        out = kernel.run_shifts(proc, personas[persona_id], plant, method,
                               f"G-tk_uprated-{persona_id}-{method}", len(rs),
                               torch.device("cpu"), costs)
        for i, exp in enumerate(rs):
            tot += 1
            cls += tank.OUTCOME_CLASSES[int(out.outcome[i])] == exp["outcome"]
            el += abs(float(out.elapsed[i]) - exp["elapsedS"]) <= 1e-3
            co += abs(float(out.cost[i]) - exp["costEur"]) <= 2e-3 * max(1.0, abs(exp["costEur"]))
    return cls, el, co, tot


variants = []
for frac in [0.49, 0.5, 0.51, 0.52, 0.53, 0.55, 0.6, 0.47, 0.45, 0.44, 0.42, 0.4]:
    p = deepcopy(base)
    p["freeboardPct"] = frac
    variants.append((f"freeboardPct={frac}", p))
for dr in [0.1, 0.12, 0.18, 0.25, 0.3]:
    p = deepcopy(base)
    p["protection"] = dict(base["protection"], driftRate=dr)
    variants.append((f"driftRate={dr}", p))
p = deepcopy(base)
p["protection"] = dict(base["protection"], autoTrip=True)
variants.append(("autoTrip=True", p))
for prod in ["default", "gasoline", "diesel"]:
    p = deepcopy(base)
    p["product"] = prod
    variants.append((f"product={prod}", p))
# fields that would move the HEP worksheet, so they are expected to fail: kept in
# the scan because a pass here would mean hep.json is stale in a different way
for iso in [[], ["V4"], ["PIS", "V4"]]:
    p = deepcopy(base)
    p["preIsolated"] = iso
    variants.append((f"preIsolated={iso}", p))
p = deepcopy(base)
p["protection"] = {k: v for k, v in base["protection"].items() if k != "alarmFrequentFalse"}
variants.append(("alarmFrequentFalse removed", p))
p = deepcopy(base)
p["provenRecent"] = False
variants.append(("provenRecent=False", p))

best = []
for label, plant in variants:
    c, e, co, t = score(plant)
    best.append((e, c, co, t, label))
    print(f"{label:34s} class {c}/{t}  elapsed {e}/{t}  cost {co}/{t}")
print()
for e, c, co, t, label in sorted(best, reverse=True)[:3]:
    print("best:", label, "elapsed", e, "class", c, "cost", co, "of", t)
