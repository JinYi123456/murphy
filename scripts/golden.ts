import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import proc from '../data/procedures/OP-TRF-014.json';
import personasRaw from '../data/personas.json';
import plantsRaw from '../data/plants.json';
import { drawU32, seedToKey } from '../src/engine/prng';
import { getTwin } from '../src/engine/twins/index';
import { simulateShift } from '../src/engine/runner';
import { costOf } from '../src/engine/economics';
import { computeHep } from '../src/engine/hra';
import { assess } from '../src/engine/assess';
import { conditionsFor } from '../src/engine/runner';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../src/engine/types';

/**
 * Golden fixtures.
 *
 * The PyTorch engine on the AMD GPU is an independent re-implementation of the
 * same model, written from the same documents but not from the same code. These
 * files are the contract between them: if the two disagree, one of them is
 * wrong, and the disagreement is a bug report rather than a rounding note.
 */

const OUT = join(process.cwd(), 'data', 'golden');
mkdirSync(OUT, { recursive: true });
const write = (name: string, data: unknown) => {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 1));
  console.log('wrote', name);
};

// 1. random stream
const SEED = 'MURPHY-GOLDEN-1';
const key = seedToKey(SEED);
const stream: { scn: number; pos: number; lane: number; u32: number }[] = [];
for (const scn of [0, 1, 7, 42, 991, 65535, 70000]) {
  for (const pos of [0, 1, 16, 137, 4095]) {
    for (let lane = 0; lane < 4; lane++) {
      stream.push({ scn, pos, lane, u32: drawU32(key, scn, pos, lane) });
    }
  }
}
write('philox.json', { seed: SEED, key, vectors: stream });

// 2. twin step function, over a designed matrix of discrete states
const twin = getTwin('tank_transfer');
const p = twin.params;
const discCases: Record<string, number>[] = [];
const flags = twin.discs;
for (let i = 0; i < 64; i++) {
  const d: Record<string, number> = {};
  for (let b = 0; b < 6; b++) d[flags[b]] = (i >> b) & 1;
  d['PISFAIL'] = i % 3 === 0 ? 1 : 0;
  d['gaugeBias'] = ((i % 7) - 3) * 0.12;
  d['flowScale'] = 0.7 + (i % 5) * 0.08;
  d['V3LEAK'] = i % 4 === 0 ? 1 : 0;
  d['BUND_HEADROOM'] = i % 8 === 0 ? 0.35 : 1;
  d['BOND_OK'] = i % 5 === 0 ? 0 : 1;
  d['HAMMER'] = i % 11 === 0 ? 1 : 0;
  d['HOSE_SPILL'] = i % 13 === 0 ? 1 : 0;
  discCases.push(d);
}
const steps: unknown[] = [];
for (const dc of discCases) {
  for (const startFrac of [0.35, 0.49, 0.62, 0.94, 0.99]) {
    const s = new Float64Array(twin.vars.length);
    const d = new Float64Array(twin.discs.length);
    for (const [k, v] of Object.entries(dc)) d[twin.discIndex(k)] = v;
    twin.init(s, 0, d, 0, p, {
      startLevelFrac: startFrac, protection: {}, provenRecent: true,
      preIsolated: [], indicatorBias: d[twin.discIndex('gaugeBias')], product: 'toluene',
    });
    for (let t = 0; t < 40; t++) twin.advance(s, 0, d, 0, p, 15);
    steps.push({
      startLevelFrac: startFrac,
      disc: dc,
      state: Array.from(s).map((x) => Number(x.toFixed(9))),
      after: Array.from(d).map((x) => Number(x.toFixed(9))),
      magnitudes: twin.magnitudes(s, 0, d, 0),
      classify: twin.classify(s, 0, d, 0, p),
    });
  }
}
write('tank_steps.json', { twin: 'tank_transfer', vars: twin.vars, discs: twin.discs, params: p, dtS: 15, ticks: 40, cases: steps });

// 3. HRA worksheet derivations, one per step per persona, all three methods
const procedure = proc as unknown as Procedure;
const personas = personasRaw as PersonaTraits[];
const plants = plantsRaw as unknown as PlantConfig[];
const hep: unknown[] = [];
for (const step of procedure.steps) {
  for (const persona of personas) {
    for (const plant of plants.filter((x) => x.twin === 'tank_transfer')) {
      for (const method of ['sparh', 'therp', 'heart'] as const) {
        const conds = conditionsFor(step, persona, plant, {
          slipRatio: 1.12, alarmRinging: false, hazardSeen: false,
          setup: { permitLeftSomethingIsolated: false, instrumentDrift: 0, driveDegraded: 1, protectionFailedOnDemand: false },
        }, (procedure.warnings ?? []).map((w) => ({ cond: w.cond, level: w.level, steps: w.steps })));
        const a = assess({ step, persona, plant, alarmRinging: false }, conds);
        const r = computeHep({ method, kind: step.kind, similarity: step.similarity, insideProcedure: !!step.applies, psfs: a.rows, gtt: step.gtt });
        hep.push({
          step: step.id, persona: persona.id, plant: plant.id, method,
          p: r.p, nominal: r.nominal, multiplier: r.multiplier, adjusted: r.adjusted,
          levels: r.rows.map((x) => `${x.id}:${x.level}:${x.mult}`),
        });
      }
    }
  }
}
write('hep.json', hep);

// 4. complete shifts
const shifts: unknown[] = [];
for (const plant of plants.filter((x) => x.twin === 'tank_transfer')) {
  for (const persona of personas) {
    for (const method of ['sparh', 'heart'] as const) {
      const cfg: RunConfig = { procedure, persona, plant, method, seed: `G-${plant.id}-${persona.id}-${method}` };
      for (let scn = 0; scn < 60; scn++) {
        // the fixture is generated through the same options the application's
        // replay path uses, so the second implementation is validated against
        // what a user actually sees rather than a special test-only configuration
        const r = simulateShift(cfg, scn, { trace: true, sampleEveryS: 8 });
        const c = costOf(cfg.procedure.twin, r.outcome, r.peak, plant.product ?? 'default');
        shifts.push({
          plant: plant.id, persona: persona.id, method, seed: cfg.seed, scn,
          outcome: r.outcome, failed: r.failed, nearMiss: r.nearMiss,
          errors: r.errors.map((e) => `${e.stepId}/${e.errorId}@${e.atS.toFixed(1)}`),
          caught: Object.keys(r.caughtBy).sort(),
          elapsedS: Number(r.elapsedS.toFixed(3)),
          costEur: Number(c.totalEur.toFixed(3)),
          peak: Object.fromEntries(Object.entries(r.peak).map(([k, v]) => [k, Number(Number(v).toFixed(6))])),
        });
      }
    }
  }
}
write('shifts.json', shifts);
console.log('golden fixtures written to', OUT);
