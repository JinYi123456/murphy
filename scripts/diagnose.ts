import { buildRunConfig } from '../src/lib/registry';
import { simulateShift } from '../src/engine/runner';
import { costOf } from '../src/engine/economics';

const which = process.argv[2] ?? 'furnace';
const cfg = buildRunConfig(which === 'furnace'
  ? { procedureId: 'OP-HT-006', personaId: 'daytime_competent', plantId: 'fn_after_lining_repair', method: 'sparh', controls: [], n: 50, seed: 'diag' }
  : { procedureId: 'OP-TRF-014', personaId: 'night_trainee', plantId: 'tk_after_instrument_work', method: 'sparh', controls: [], n: 50, seed: 'diag' });

const r = simulateShift(cfg, 3, { trace: true });
const cost = costOf(cfg.procedure.twin, r.outcome, r.peak, cfg.plant.product ?? 'default');
console.log(`scenario 3 -> ${r.outcome} | slip ${r.scheduleSlip.toFixed(2)} | EUR ${Math.round(cost.totalEur)}`);
console.log(`note: ${r.note}`);
for (const a of r.audit) {
  console.log(`\n${a.stepId} p=${(a.p * 100).toFixed(1)}% (band ${(a.lo * 100).toFixed(1)}-${(a.hi * 100).toFixed(0)}) nominal=${a.nominal.toExponential(1)} C=${a.multiplier.toFixed(2)} kind=${a.kind}${a.adjusted ? ' [adjusted]' : ''}`);
  for (const row of a.rows) console.log(`    ${row.id} "${row.level}" x${row.mult}  <- ${row.why.slice(0, 74)}`);
  for (const s of a.suppressed) console.log(`    SUPPRESSED ${s.psf}: ${s.why.slice(0, 74)}`);
}
console.log('\n--- tape ---');
for (const t of r.trace) console.log(`${t.tS.toFixed(0).padStart(6)}s ${t.kind.padEnd(9)} ${t.label}${t.detail ? ' | ' + t.detail.slice(0, 90) : ''}`);
