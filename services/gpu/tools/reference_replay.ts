import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import proc from '../../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../../data/personas.json';
import plantsRaw from '../../../data/plants.json';
import { simulateShift } from '../../../src/engine/runner';
import { costOf } from '../../../src/engine/economics';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../../../src/engine/types';

/**
 * Replay the fixture's configurations with the reference engine.
 *
 * `data/golden/shifts.json` is a snapshot of the reference at one moment; the
 * fixture inputs (plants, personas, procedure) keep being edited afterwards, so
 * a disagreement against the file alone cannot say which engine is wrong. This
 * dumps what the current reference produces for the same configurations, which
 * turns the check into a three-way comparison: fixture, reference as it is now,
 * tensor kernel.
 *
 * Run:  npx tsx services/gpu/tools/reference_replay.ts
 * Out:  data/bench/reference_replay.json
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const outDir = join(repoRoot, 'data', 'bench');

const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = (plantsRaw as PlantConfig[]).filter((p) => p.twin === 'tank_transfer');

const rows: unknown[] = [];
for (const plant of plants) {
  for (const persona of personas) {
    for (const method of ['sparh', 'heart'] as const) {
      const seed = `G-${plant.id}-${persona.id}-${method}`;
      const cfg: RunConfig = { procedure, persona, plant, method, seed };
      for (let scn = 0; scn < 60; scn++) {
        const r = simulateShift(cfg, scn);
        const c = costOf(procedure.twin, r.outcome, r.peak, plant.product ?? 'default');
        rows.push({
          plant: plant.id, persona: persona.id, method, seed, scn,
          outcome: r.outcome,
          failed: r.failed,
          nearMiss: r.nearMiss,
          elapsedS: r.elapsedS,
          hazardSeconds: r.hazardSeconds,
          scheduleSlip: r.scheduleSlip,
          costEur: c.totalEur,
          errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(1)}`),
          caught: Object.keys(r.caughtBy).sort(),
          peak: r.peak,
        });
      }
    }
  }
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'reference_replay.json');
writeFileSync(file, JSON.stringify(rows));
console.log(`wrote ${rows.length} reference replays to ${file}`);
