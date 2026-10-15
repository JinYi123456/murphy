import { runBatch } from '../src/engine/batch';
import { simulateShift } from '../src/engine/runner';
import { inspectModel } from '../src/engine/model';
import { PROCEDURES, PERSONAS, PLANTS, buildRunConfig } from '../src/lib/registry';
import type { ConsoleConfig } from '../src/lib/registry';

/**
 * A read-out of the whole model: every procedure, every plant state, every crew.
 * Used during development to check the numbers stay in a range a process-safety
 * engineer would recognise, and shipped so anybody can reproduce the figures
 * quoted in the write-up.
 */
const n = Number(process.argv[2] ?? 4000);
const only = process.argv[3];

for (const procedure of PROCEDURES) {
  const report = inspectModel(procedure);
  console.log(`\n=== ${procedure.id} rev ${procedure.revision} (${procedure.twin}) ===`);
  console.log(`  integrity ${report.ok ? 'PASS' : 'FAIL'} - ${procedure.steps.length} steps, ${report.notes.join('; ')}`);
  for (const e of report.errors) console.log('  ERROR', e);
  if (!report.ok) continue;

  for (const plant of PLANTS.filter((x) => x.twin === procedure.twin)) {
    if (only && plant.id !== only) continue;
    const rows = PERSONAS.map((persona) => {
      const cfg: ConsoleConfig = {
        procedureId: procedure.id, personaId: persona.id, plantId: plant.id,
        method: 'sparh', controls: [], n, seed: `smoke-${plant.id}-${persona.id}`,
      };
      const s = runBatch(buildRunConfig(cfg), n).summary;
      const top = Object.entries(s.perStep)
        .filter(([, v]) => v.causalFailure > 0)
        .sort((a, b) => b[1].causalFailure - a[1].causalFailure)
        .slice(0, 2)
        .map(([id, v]) => `${id} ${(v.p * 100).toFixed(1)}%`)
        .join(' ');
      return { persona: persona.id, s, top };
    });

    console.log(`\n  ${plant.id} - ${plant.label}`);
    console.log(`  ${plant.notes}`);
    for (const r of rows) {
      const outcomes = Object.entries(r.s.outcomeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${((v / n) * 100).toFixed(1)}%`)
        .join(', ');
      console.log(
        `    ${r.persona.padEnd(20)} fail ${(r.s.failureRate * 100).toFixed(2).padStart(6)}%`
        + `  mean EUR ${Math.round(r.s.meanCostEur).toLocaleString('en-US').padStart(9)}`
        + `  /yr ${Math.round(r.s.annualLossEur).toLocaleString('en-US').padStart(11)}  [${r.top}]`,
      );
      console.log(`      ${outcomes}`);
    }
  }
}

const cfg: ConsoleConfig = {
  procedureId: 'OP-TRF-014', personaId: 'night_trainee', plantId: 'tk_after_instrument_work',
  method: 'sparh', controls: [], n: 200, seed: 'replay-check',
};
const run = buildRunConfig(cfg);
const a = simulateShift(run, 7, { trace: true });
const b = simulateShift(run, 7, { trace: true });
console.log('\nreplay determinism:', a.outcome === b.outcome && a.trace.length === b.trace.length ? 'OK' : 'FAILED');
console.log(`scenario 7 -> ${a.outcome} | ${a.note} | release ${(a.peak.releaseM3 ?? 0).toFixed(2)} m3 | ${(a.series.length)} frames, ${a.trace.length} tape events`);
