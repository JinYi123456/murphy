import proc from '../../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../../data/personas.json';
import plantsRaw from '../../../data/plants.json';
import { simulateShift } from '../../../src/engine/runner';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../../../src/engine/types';

/** Scratch tool: print the reference engine's per-step time boundaries for one
 *  scenario as JSON, so the tensor kernel can be diffed step by step.
 *  Usage: npx tsx tools/trace_ts.ts <plant> <persona> <method> <scn>
 *  Not part of the deliverable. */

const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = plantsRaw as PlantConfig[];

const plantId = process.argv[2] ?? 'tk_uprated';
const personaId = process.argv[3] ?? 'daytime_competent';
const method = (process.argv[4] ?? 'sparh') as 'sparh' | 'therp' | 'heart';
const scn = Number(process.argv[5] ?? 0);

const plant = plants.find((p) => p.id === plantId)!;
const persona = personas.find((p) => p.id === personaId)!;
const cfg: RunConfig = { procedure, persona, plant, method, seed: `G-${plantId}-${personaId}-${method}` };

const r = simulateShift(cfg, scn, { trace: true });
const ids = procedure.steps.map((s) => s.id);

// every step logs exactly one event at its own start time; a guarded-out step
// logs with skipped=1 and the following step therefore has the same timestamp
const starts: Record<string, number> = {};
const skipped: Record<string, boolean> = {};
for (const e of r.trace) {
  if (e.kind === 'step' && e.stepId) {
    starts[e.stepId] = e.tS;
    if (e.vars?.skipped) skipped[e.stepId] = true;
  }
}

const events = r.trace
  .filter((e) => e.kind !== 'step')
  .map((e) => `${e.tS.toFixed(4)} ${e.kind} ${e.stepId ?? ''} ${e.label}`);

const rows: unknown[] = [];
let prev = 0;
for (const id of ids) {
  if (starts[id] === undefined) { rows.push({ id, reached: false }); continue; }
  rows.push({
    id,
    reached: true,
    skipped: skipped[id] === true,
    tStart: Number(starts[id].toFixed(4)),
    durToNext: Number((starts[id] - prev).toFixed(4)),
  });
  prev = starts[id];
}

console.log(JSON.stringify({
  plant: plantId, persona: personaId, method, scn,
  outcome: r.outcome, elapsedS: Number(r.elapsedS.toFixed(4)),
  hazardSeconds: Number(r.hazardSeconds.toFixed(4)),
  scheduleSlip: Number(r.scheduleSlip.toFixed(6)),
  steps: rows,
  errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(3)}`),
  caught: Object.keys(r.caughtBy).sort(),
  events,
}, null, 1));
