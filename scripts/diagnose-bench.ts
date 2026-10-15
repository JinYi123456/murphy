import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunConfig } from '../src/lib/registry';
import { hypothesesFor, synthesizeObservation, diagnose, channelsFor } from '../src/engine/diagnose';
import type { ConsoleConfig } from '../src/lib/registry';
import { simulateShift } from '../src/engine/runner';

/**
 * Two questions, measured separately, because conflating them is how a
 * diagnostic tool gets away with claiming a number it cannot support.
 *
 * 1. Observability. Force each error mode and run it against the same plant with
 *    the same random state: do the instruments move at all? Most procedure
 *    failures leave no signature - a record not written, a bond clipped to paint,
 *    a check skipped when nothing was wrong anyway. A tool that reports accuracy
 *    over the whole set is scoring guesses on the invisible half.
 * 2. Identifiability. Given that something visible happened, which of the visible
 *    candidates does forward simulation rank first?
 */
const cfg: ConsoleConfig = {
  procedureId: process.argv[2] ?? 'OP-TRF-014',
  personaId: 'daytime_competent',
  plantId: process.argv[3] ?? 'tk_after_instrument_work',
  method: 'sparh',
  controls: [],
  n: 100,
  seed: 'diagnose-bench',
};
const run = buildRunConfig(cfg);
const channels = channelsFor(run.procedure.twin);
const cands = hypothesesFor(run).filter((h) => h.errorId !== null);
// the window is the whole heat, not a slice of it: an error at step 4 shows up in
// the trajectory that follows, and a short tail window would call that invisible
const windowS = Number(process.argv[4] ?? 4200);
const stepS = 15;
const REPLICAS = 8;

function forced(stepId: string, errorId: string | null) {
  return { stepId, errorId };
}

/** mean absolute increment divergence between a forced error and a clean run */
function divergence(stepId: string, errorId: string): number {
  let acc = 0;
  let n = 0;
  for (let r = 0; r < REPLICAS; r++) {
    const scn = 2000 + r;
    const f = simulateShift(run, scn, { trace: true, sampleEveryS: stepS, force: forced(stepId, errorId) });
    const c0run = simulateShift(run, scn, { trace: true, sampleEveryS: stepS, force: { stepId: '*', errorId: null } });
    const len = Math.min(f.series.length, c0run.series.length, Math.ceil(windowS / stepS));
    if (len < 3) continue;
    const fs = f.series.slice(f.series.length - len);
    const cs = c0run.series.slice(c0run.series.length - len);
    for (const ch of channels) {
      const rf = (x: (typeof fs)[number]) => {
        const raw = x.v[ch.name];
        if (!Number.isFinite(raw)) return 0;
        return ch.indicated ? raw + (x.d.gaugeBias ?? x.d.tcBias ?? 0) : raw;
      };
      const rc = (x: (typeof cs)[number]) => {
        const raw = x.v[ch.name];
        if (!Number.isFinite(raw)) return 0;
        return ch.indicated ? raw + (x.d.gaugeBias ?? x.d.tcBias ?? 0) : raw;
      };
      const f0 = rf(fs[0]);
      const c0 = rc(cs[0]);
      for (let i = 1; i < len; i++) {
        acc += Math.abs((rf(fs[i]) - f0) - (rc(cs[i]) - c0)) / ch.sigma;
        n++;
      }
    }
  }
  return n ? acc / n : 0;
}

const THRESHOLD = 0.05;
const scored = cands
  .map((c) => ({
    id: `${c.step.id}/${c.errorId}`,
    label: c.label,
    kind: c.kind,
    divergence: Number(divergence(c.step.id, c.errorId as string).toFixed(4)),
  }))
  .sort((a, b) => b.divergence - a.divergence);
const visible = scored.filter((s) => s.divergence > THRESHOLD);
const invisible = scored.filter((s) => s.divergence <= THRESHOLD);
const visibleIds = visible.map((v) => v.id);

console.log(`${scored.length} error modes on ${run.procedure.id} / ${run.plant.id}`);
console.log(`visible to the instruments (normalised divergence > ${THRESHOLD}): ${visible.length}`);
for (const v of visible.slice(0, 14)) console.log(`  ${v.id.padEnd(12)} ${v.divergence.toFixed(3).padStart(7)}  ${v.label.slice(0, 62)}`);
console.log(`invisible: ${invisible.length} (${invisible.slice(0, 5).map((i) => i.id).join(', ')}...)`);

const rows: { truth: string; rank: number; posterior: number; top: string }[] = [];
for (let i = 0; i < visible.length; i++) {
  const [stepId, errorId] = visible[i].id.split('/');
  const { obs, truth } = synthesizeObservation(run, 31 + i * 7, { stepId, errorId }, channels, windowS, stepS);
  const d = diagnose(run, obs, { replicas: 8, truth, only: visibleIds });
  const ranked = d.hypotheses.map((h) => h.id);
  const at = ranked.indexOf(truth);
  rows.push({ truth, rank: at, posterior: d.hypotheses[at]?.posterior ?? 0, top: d.hypotheses[0]?.id ?? '' });
  console.log(`  ${truth.padEnd(12)} rank ${String(at).padStart(2)}  post ${((d.hypotheses[at]?.posterior ?? 0) * 100).toFixed(1).padStart(5)}%  top=${rows[rows.length - 1].top}`);
}

const n = Math.max(1, rows.length);
const top1 = rows.filter((r) => r.rank === 0).length;
const top3 = rows.filter((r) => r.rank >= 0 && r.rank < 3).length;
const chance = 1 / Math.max(1, visible.length);
const summary = {
  key: `${run.procedure.id}/${run.plant.id}`,
  procedure: run.procedure.id,
  plant: run.plant.id,
  persona: run.persona.id,
  method: run.method,
  twin: run.procedure.twin,
  channels: channels.map((c) => c.name),
  windowS,
  stepS,
  replicas: 8,
  threshold: THRESHOLD,
  errorModes: scored.length,
  observable: visible.length,
  observableShare: visible.length / Math.max(1, scored.length),
  unobservable: invisible.map((i) => i.id),
  trials: rows.length,
  top1: top1 / n,
  top3: top3 / n,
  chanceTop1: chance,
  lift: chance > 0 ? top1 / n / chance : 0,
  divergence: scored,
  rows,
};

// One file, every measured procedure and plant state. The interface looks its own
// case up by key and shows nothing when a combination has not been measured, so a
// figure from the furnace can never be read as a figure about the tank.
const PATH = join(process.cwd(), 'data', 'bench', 'diagnosis.json');
let store: { generatedAt?: string; cases: Record<string, unknown> } = { cases: {} };
try {
  const existing = JSON.parse(readFileSync(PATH, 'utf8')) as { cases?: Record<string, unknown> };
  if (existing && typeof existing === 'object') store = { cases: existing.cases ?? {} };
} catch {
  /* first measurement */
}
store.generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');
store.cases[summary.key] = summary;
writeFileSync(PATH, JSON.stringify(store, null, 2));
console.log(`\nidentifiability over the ${visible.length} visible modes: top-1 ${(summary.top1 * 100).toFixed(0)}% (chance ${(chance * 100).toFixed(0)}%), top-3 ${(summary.top3 * 100).toFixed(0)}%, lift ${summary.lift.toFixed(1)}x`);
console.log(`observability: ${(summary.observableShare * 100).toFixed(0)}% of procedure failures move the instruments at all`);
console.log('wrote data/bench/diagnosis.json');
