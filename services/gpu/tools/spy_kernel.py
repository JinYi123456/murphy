"""Scratch: record the worksheet the batched kernel builds for one scenario."""
import json, sys, torch
sys.path.insert(0, ".")
from murphy_gpu import hra, kernel

D = lambda n: json.load(open("../../data/%s" % n, encoding="utf-8"))
proc = D("procedures/OP-TRF-014.json")
persons = {p["id"]: p for p in D("personas.json")}
plants = {p["id"]: p for p in D("plants.json") if p.get("twin") == "tank_transfer"}
costs = D("costs.json")

plant_id, persona_id, method, scn = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rows = []
orig_conditions = hra.conditions_for
orig_assess = hra.assess


def spy(step, persona, plant, ctx, warnings, batch=1, device=None):
    conds = orig_conditions(step, persona, plant, ctx, warnings, batch, device)
    lvl, sev, supp = orig_assess(step, persona, plant, conds, batch, device)
    slip = ctx["slipRatio"]
    rows.append(
        {
            "id": step["id"],
            "slip": [round(float(x), 6) for x in (slip if isinstance(slip, torch.Tensor) else [slip])],
            "alarm": [bool(x) for x in ctx["alarmRinging"].reshape(-1)] if isinstance(ctx["alarmRinging"], torch.Tensor) else ctx["alarmRinging"],
            "hazard": [bool(x) for x in ctx["hazardSeen"].reshape(-1)] if isinstance(ctx["hazardSeen"], torch.Tensor) else ctx["hazardSeen"],
            "permit": bool(ctx["permitLeftSomethingIsolated"][scn]) if isinstance(ctx["permitLeftSomethingIsolated"], torch.Tensor) else None,
            "drift": round(float(ctx["instrumentDrift"][scn]), 6) if isinstance(ctx["instrumentDrift"], torch.Tensor) else None,
            "conds": {k: int(v[scn]) for k, v in conds.items() if int(v[scn]) > 0},
            "level": lvl[scn].tolist(),
            "severity": sev[scn].tolist(),
            "supp": supp[scn].tolist(),
            "with_warnings": bool(warnings),
        }
    )
    return conds


hra.conditions_for = spy
hra.assess = orig_assess

out = kernel.run_shifts(proc, persons[persona_id], plants[plant_id], method,
                        "G-%s-%s-%s" % (plant_id, persona_id, method), scn + 1, "cpu", costs)
for r in rows:
    print(json.dumps(r))
print("elapsed", float(out.elapsed[scn]), "outcome", int(out.outcome[scn]))
