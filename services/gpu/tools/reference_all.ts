import proc from '../../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../../data/personas.json';
import plantsRaw from '../../../data/plants.json';
import { simulateShift } from '../../../src/engine/runner';
import { costOf } from '../../../src/engine/economics';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../../../src/engine/types';

/** Scratch: replay every fixture group with the reference engine. */
const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = (plantsRaw as PlantConfig[]).filter((p) => p.twin === 'tank_transfer');
const rows: unknown[] = [];
for (const plant of plants) {
  for (const persona of personas) {
    for (const method of ['sparh', 'heart'] as const) {
      const cfg: RunConfig = { procedure, persona, plant, method, seed: `G-${plant.id}-${persona.id}-${method}` };
      for (let scn = 0; scn < 60; scn++) {
        const r = simulateShift(cfg, scn);
        const c = costOf(cfg.procedure.twin, r.outcome, r.peak, plant.product ?? 'default');
        rows.push({
          plant: plant.id, persona: persona.id, method, scn, outcome: r.outcome,
          elapsedS: Number(r.elapsedS.toFixed(3)), costEur: Number(c.totalEur.toFixed(3)),
          errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(1)}`),
        });
      }
    }
  }
}
console.log(JSON.stringify(rows));
