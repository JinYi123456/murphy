import proc from '../data/procedures/OP-TRF-014.json';
import personas from '../data/personas.json';
import plants from '../data/plants.json';
import { inspectModel } from '../src/engine/model';
import { runBatch } from '../src/engine/batch';
import { simulateShift } from '../src/engine/runner';
import type { PersonaTraits, PlantConfig, RunConfig } from '../src/engine/types';

const report = inspectModel(proc);
console.log('model ok:', report.ok);
for (const e of report.errors) console.log('  ERROR', e);
for (const n of report.notes) console.log('  note ', n);
if (!report.ok) process.exit(1);

const procedure = report.procedure!;
const n = Number(process.argv[2] ?? 4000);

for (const plant of plants as PlantConfig[]) {
  if (plant.twin !== procedure.twin) continue;
  for (const persona of personas as PersonaTraits[]) {
    const cfg: RunConfig = { procedure, persona, plant, method: 'sparh', seed: `smoke-${plant.id}-${persona.id}` };
    const { summary } = runBatch(cfg, n);
    const outcomes = Object.entries(summary.outcomeCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(v / n * 100).toFixed(1)}%`)
      .join(', ');
    console.log(`\n${plant.id} / ${persona.id}`);
    console.log(`  failure ${(summary.failureRate * 100).toFixed(2)}%  near-miss ${(summary.nearMissRate * 100).toFixed(1)}%  mean EUR ${summary.meanCostEur.toFixed(0)}  annual EUR ${summary.annualLossEur.toFixed(0)}`);
    console.log(`  ${outcomes}`);
    const top = Object.entries(summary.perStep)
      .filter(([, v]) => v.causalFailure > 0)
      .sort((a, b) => b[1].causalFailure - a[1].causalFailure)
      .slice(0, 3);
    for (const [id, v] of top) console.log(`    ${id}: thrown ${v.thrown} escaped ${v.escaped} causalFail ${v.causalFailure} p ${v.p.toExponential(2)}  ${v.title.slice(0, 52)}`);
  }
}

const cfg: RunConfig = {
  procedure,
  persona: (personas as PersonaTraits[])[1],
  plant: (plants as PlantConfig[]).find((x) => x.id === 'tk_after_instrument_work')!,
  method: 'sparh',
  seed: 'replay-check',
};
const a = simulateShift(cfg, 7, { trace: true });
const b = simulateShift(cfg, 7, { trace: true });
console.log('\nreplay determinism:', a.outcome === b.outcome && a.trace.length === b.trace.length ? 'OK' : 'FAILED');
console.log('scenario 7 ->', a.outcome, a.note, '| release', a.peak.releaseM3?.toFixed(2), 'm3 | EUR', Math.round(a.peak.releaseM3 ?? 0));
console.log('trace events:', a.trace.length, 'series points:', a.series.length);
for (const t of a.trace.slice(0, 14)) console.log(`  ${t.tS.toFixed(0).padStart(5)}s ${t.kind.padEnd(9)} ${t.label}${t.detail ? ' - ' + t.detail.slice(0, 72) : ''}`);
