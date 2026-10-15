"""Scratch: print the batched kernel's per-step time boundaries for one scenario.

Run:  python tools/trace_one.py <plant> <persona> <method> <scn>
Emits the same JSON shape as tools/trace_ts.ts so the two can be diffed directly.
Not part of the deliverable.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import torch  # noqa: E402

from murphy_gpu import kernel  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data"

plant_id = sys.argv[1] if len(sys.argv) > 1 else "tk_uprated"
persona_id = sys.argv[2] if len(sys.argv) > 2 else "daytime_competent"
method = sys.argv[3] if len(sys.argv) > 3 else "sparh"
scn = int(sys.argv[4]) if len(sys.argv) > 4 else 0

proc = json.load(open(DATA / "procedures" / "OP-TRF-014.json", encoding="utf-8"))
personas = {p["id"]: p for p in json.load(open(DATA / "personas.json", encoding="utf-8"))}
plants = {p["id"]: p for p in json.load(open(DATA / "plants.json", encoding="utf-8"))}
costs = json.load(open(DATA / "costs.json", encoding="utf-8"))

B = scn + 1
row = scn
ticks_during_step = [0] * len(proc["steps"])
closing_ticks = [0]


def col(t):
    return float(t[row])


orig_run_step = kernel._Batch.run_step
orig_integrate_for = kernel._Batch.integrate_for
orig_advance_while = kernel._Batch._advance_while
orig_run_watch = kernel._Batch.run_watch

current_step = [-1]
in_closing = [False]


def advance_while(self, running):
    if bool(running[row]):
        if in_closing[0]:
            closing_ticks[0] += 1
        elif current_step[0] >= 0:
            ticks_during_step[current_step[0]] += 1
    return orig_advance_while(self, running)


def run_step(self, j):
    current_step[0] = j
    t0 = col(self.elapsed)
    alive0 = bool(self.alive[row])
    orig_run_step(self, j)
    step = self.steps[j]
    step_trace.append({
        "id": step["id"],
        "tStart": round(t0, 4),
        "tEnd": round(col(self.elapsed), 4),
        "aliveBefore": alive0,
        "aliveAfter": bool(self.alive[row]),
        "hazardAfter": round(col(self.hazard_seconds), 4),
        "watchTicks": ticks_during_step[j],
    })
    current_step[0] = -1


step_trace = []


def run_closing(self):
    in_closing[0] = True
    orig_run_closing(self)
    in_closing[0] = False


orig_run_closing = kernel._Batch.run_closing

kernel._Batch.run_step = run_step
kernel._Batch.integrate_for = orig_integrate_for
kernel._Batch._advance_while = advance_while
kernel._Batch.run_closing = run_closing

out = kernel.run_shifts(proc, personas[persona_id], plants[plant_id], method,
                        f"G-{plant_id}-{persona_id}-{method}", B, torch.device("cpu"), costs)

from murphy_gpu import tank  # noqa: E402

print(json.dumps({
    "plant": plant_id, "persona": persona_id, "method": method, "scn": scn,
    "outcome": tank.OUTCOME_CLASSES[int(out.outcome[row])],
    "elapsedS": round(float(out.elapsed[row]), 4),
    "hazardSeconds": round(float(out.hazard_seconds[row]), 4),
    "steps": step_trace,
    "closingTicks": closing_ticks[0],
    "errors": [
        f"{proc['steps'][j]['id']}/{proc['steps'][j]['errors'][int(out.alternative[row, j])]['id']}"
        f"@{float(out.error_at_s[row, j]):.3f}"
        for j in range(len(proc["steps"])) if bool(out.escaped[row, j])
    ],
    "caught": sorted(
        f"{proc['steps'][j]['id']}/{proc['steps'][j]['errors'][int(out.alternative[row, j])]['id']}"
        for j in range(len(proc["steps"])) if bool(out.caught[row, j])
    ),
}, indent=1))
