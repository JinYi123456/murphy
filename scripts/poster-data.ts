import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunConfig } from '../src/lib/registry';
import { runBatch, simulateShift } from '../src/engine/index';
import type { ConsoleConfig } from '../src/lib/registry';

/**
 * Dump the real numbers a cover or a slide needs.
 *
 * The poster is drawn from an actual run rather than illustrated, so anything a
 * judge can see in the interface is also what the image is built from.
 */
const cfg: ConsoleConfig = {
  procedureId: 'OP-TRF-014',
  personaId: 'night_trainee',
  plantId: 'tk_after_instrument_work',
  method: 'sparh',
  controls: [],
  n: 4000,
  seed: 'poster-1',
};
const run = buildRunConfig(cfg);
const { summary } = runBatch(run, cfg.n, { variantId: 'poster', collectWorst: 1 });
const shift = simulateShift(run, summary.worst[0] ?? 0, { trace: true, sampleEveryS: 15 });

writeFileSync(join(process.cwd(), 'build-poster.json'), JSON.stringify({
  cfg: { procedure: run.procedure.id, revision: run.procedure.revision, persona: run.persona.label, plant: run.plant.label },
  summary: {
    failureRate: summary.failureRate,
    incidentRate: summary.incidentRate,
    upsetRate: summary.upsetRate,
    nearMissRate: summary.nearMissRate,
    annualLossEur: summary.annualLossEur,
    meanCostEur: summary.meanCostEur,
    outcomeCounts: summary.outcomeCounts,
    n: summary.n,
  },
  steps: run.procedure.steps.map((s) => ({
    id: s.id, title: s.title, durS: s.durS, kind: s.kind, cue: s.cue,
    stat: summary.perStep[s.id] ?? null,
  })),
  shift: {
    outcome: shift.outcome, note: shift.note, elapsedS: shift.elapsedS,
    series: shift.series.map((f) => ({
      tS: f.tS, level: f.v.level, spill: f.v.spill, tankP: f.v.tankP, lineP: f.v.lineP,
      pump: f.d.PUMP, stop: f.d.STOP, v4: f.d.V4, pis: f.d.PIS, alarm: f.v.lahLatched,
    })),
    events: shift.trace
      .filter((e) => e.kind === 'error' || e.kind === 'hazard' || e.kind === 'alarm' || e.kind === 'outcome')
      .map((e) => ({ tS: e.tS, kind: e.kind, label: e.label, detail: (e.detail ?? '').slice(0, 160) })),
  },
  params: { hAl: 9.3, hAh: 9.6, hOverflow: 10.0, batchM3: 55 },
}, null, 1));
console.log('build-poster.json written:', summary.failureRate.toFixed(4), shift.outcome, shift.series.length, 'frames');
