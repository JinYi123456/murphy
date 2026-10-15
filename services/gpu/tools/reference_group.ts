import proc from '../../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../../data/personas.json';
import plantsRaw from '../../../data/plants.json';
import { simulateShift } from '../../../src/engine/runner';
import { costOf } from '../../../src/engine/economics';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../../../src/engine/types';

/** Scratch tool: replay a whole fixture group with the reference engine and
 *  print the same fields the fixture stores, so a three-way comparison
 *  (fixture vs reference vs tensor kernel) can be made. Not a deliverable. */

const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = plantsRaw as PlantConfig[];

const plantId = process.argv[2]!;
const personaId = process.argv[3]!;
const method = (process.argv[4] ?? 'sparh') as 'sparh' | 'therp' | 'heart';
const count = Number(process.argv[5] ?? 60);

const plant = plants.find((p) => p.id === plantId)!;
const persona = personas.find((p) => p.id === personaId)!;
const cfg: RunConfig = { procedure, persona, plant, method, seed: `G-${plantId}-${personaId}-${method}` };

const rows: unknown[] = [];
for (let scn = 0; scn < count; scn++) {
  const r = simulateShift(cfg, scn);
  const c = costOf(cfg.procedure.twin, r.outcome, r.peak, plant.product ?? 'default');
  rows.push({
    scn,
    outcome: r.outcome,
    elapsedS: Number(r.elapsedS.toFixed(3)),
    costEur: Number(c.totalEur.toFixed(3)),
    errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(1)}`),
  });
}
console.log(JSON.stringify(rows));
