"""Scratch: per-group elapsed agreement between the batched kernel and the fixture.

Not part of the deliverable: it exists to turn "93% of scenarios disagree" into a
list of whole-tick offsets that can be attributed to one mechanism.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch  # noqa: E402

from murphy_gpu import kernel  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data"
fx = json.load(open(DATA / "golden" / "shifts.json", encoding="utf-8"))
proc = json.load(open(DATA / "procedures" / "OP-TRF-014.json", encoding="utf-8"))
personas = {p["id"]: p for p in json.load(open(DATA / "personas.json", encoding="utf-8"))}
plants = {p["id"]: p for p in json.load(open(DATA / "plants.json", encoding="utf-8"))
          if p.get("twin") == "tank_transfer"}
costs = json.load(open(DATA / "costs.json", encoding="utf-8"))

groups = defaultdict(list)
for r in fx:
    groups[(r["plant"], r["persona"], r["method"], r["seed"])].append(r)

tick = 15.0
hist = Counter()
worst = defaultdict(list)
for (plant_id, persona_id, method, seed), rows in sorted(groups.items()):
    rows = sorted(rows, key=lambda r: r["scn"])
    out = kernel.run_shifts(proc, personas[persona_id], plants[plant_id], method, seed,
                           len(rows), torch.device("cpu"), costs)
    for i, exp in enumerate(rows):
        got = float(out.elapsed[i])
        d = got - float(exp["elapsedS"])
        if abs(d) > 1e-3:
            hist[round(d, 3)] += 1
            worst[(plant_id, persona_id, method)].append((exp["scn"], round(d, 3)))

print("groups with elapsed drift:", len(worst), "of", len(groups))
for k, v in sorted(worst.items()):
    print(" ", k, "n=", len(v), "offsets", sorted({x[1] for x in v})[:12])
print()
print("offset histogram (value: count), all multiples of the tick:", sorted(hist.items()))
print("total drifted:", sum(hist.values()))
