import proc from '../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../data/personas.json';
import plantsRaw from '../../data/plants.json';
import { simulateShift } from '../../src/engine/runner';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../../src/engine/types';

/** Scratch tool: dump the reference's per-step audit for one scenario so the
 *  tensor kernel can be diffed against it. Not part of the deliverable. */

const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = plantsRaw as PlantConfig[];

const plantId = process.argv[2] ?? 'tk_after_instrument_work';
const personaId = process.argv[3] ?? 'daytime_competent';
const method = (process.argv[4] ?? 'sparh') as 'sparh' | 'therp' | 'heart';
const scn = Number(process.argv[5] ?? 3);

const plant = plants.find((p) => p.id === plantId)!;
const persona = personas.find((p) => p.id === personaId)!;
const cfg: RunConfig = { procedure, persona, plant, method, seed: `G-${plantId}-${personaId}-${method}` };

const r = simulateShift(cfg, scn, { trace: true });
const out = {
  scn,
  outcome: r.outcome,
  elapsedS: r.elapsedS,
  errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(1)}`),
  caught: Object.keys(r.caughtBy).sort(),
  steps: r.audit.map((a) => ({
    id: a.stepId,
    p: a.p,
    mult: a.multiplier,
    nominal: a.nominal,
    adjusted: a.adjusted,
    conditions: a.conditions,
    rows: a.rows.map((x) => `${x.id}:${x.level}:${x.mult}`),
    suppressed: a.suppressed.map((x) => x.psf),
  })),
};
console.log(JSON.stringify(out, null, 1));
