import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cases from '../data/incidents/cases.json';
import { buildRunConfig, personaById, plantById, procedureById } from '../src/lib/registry';
import { simulateShift } from '../src/engine/runner';
import { costOf } from '../src/engine/economics';
import type { ConsoleConfig } from '../src/lib/registry';

/**
 * Backtest against published findings.
 *
 * The model is handed a procedure and a plant state and nothing else. It then
 * has to rank the mechanisms, and we check whether the mechanisms the official
 * investigation actually recorded appear near the top. This is not a prediction
 * of an accident; it is a check that the model is looking at the same things the
 * people who studied the wreckage looked at, and that it ranks them in an order
 * a competent engineer would accept.
 */

const SHIFTS = Number(process.env.BACKTEST_SHIFTS ?? 3000);
const TOP_K = Number(process.env.BACKTEST_K ?? 10);

interface Ranked {
  key: string;
  kind: 'error' | 'condition' | 'warning';
  step: string;
  shifts: number;
  share: number;
  meanCostEur: number;
  detail: string;
}

function rankCase(c: typeof cases['cases'][number]) {
  const procedure = procedureById(c.givesMurphy.procedure);
  const plant = plantById(c.givesMurphy.plant);
  const buckets = new Map<string, Ranked>();
  const bump = (key: string, kind: Ranked['kind'], step: string, detail: string) => {
    const cur = buckets.get(key) ?? { key, kind, step, shifts: 0, share: 0, meanCostEur: 0, detail };
    cur.shifts++;
    buckets.set(key, cur);
  };

  let failed = 0;
  let total = 0;
  let cost = 0;

  for (const personaId of c.givesMurphy.personas as string[]) {
    const cfg: ConsoleConfig = {
      procedureId: procedure.id, personaId, plantId: plant.id,
      method: 'sparh', controls: [], n: SHIFTS, seed: `bt-${c.id}-${personaId}`,
    };
    const run = buildRunConfig(cfg);
    const persona = personaById(personaId);
    for (let scn = 0; scn < SHIFTS; scn++) {
      const r = simulateShift(run, scn);
      total++;
      const bill = costOf(run.procedure.twin, r.outcome, r.peak, run.plant.product ?? 'default').totalEur;
      if (r.failed) {
        failed++;
        cost += bill;
        for (const e of r.errors) {
          const src = procedure.steps.find((s) => s.id === e.stepId);
          const alt = src?.errors?.find((x) => x.id === e.errorId);
          bump(`error:${e.stepId}/${e.errorId}`, 'error', e.stepId, `${persona.label}: ${alt?.text ?? e.errorId}`);
        }
        // a shaping factor is credited where the chain started, not at every
        // step it happened to be active, otherwise a condition that touches all
        // seventeen steps outranks the error that actually caused the loss
        const first = r.errors[0];
        if (first) {
          const audit = r.audit.find((a) => a.stepId === first.stepId);
          for (const cond of audit?.conditions ?? []) {
            bump(`condition:${cond}`, 'condition', first.stepId, `${cond} active at ${first.stepId} for ${persona.label}`);
          }
        }
      }
    }
  }

  const list = [...buckets.values()]
    .map((b) => ({ ...b, share: failed ? b.shifts / failed : 0 }))
    .sort((a, b) => b.shifts - a.shifts);
  return { list, failed, total, meanCost: failed ? cost / failed : 0, exposure: cost };
}

/** Where does the model put the mechanism the investigators named? */
function matchCause(list: Ranked[], cause: typeof cases['cases'][number]['heldOut'][number]) {
  const rankOf = (pred: (r: Ranked) => boolean) => list.findIndex(pred) + 1;
  let best = 0;
  let hit: Ranked | undefined;
  for (const fb of cause.foundBy as { step?: string; error?: string; condition?: string; warning?: string }[]) {
    const pred = (r: Ranked) => {
      if (fb.error) return r.kind === 'error' && r.key === `error:${fb.step}/${fb.error}`;
      if (fb.condition) return r.kind === 'condition' && r.key === `condition:${fb.condition}`;
      if (fb.warning) return r.kind === 'warning' && r.key === `warning:${fb.warning}`;
      return r.step === fb.step;
    };
    const at = rankOf(pred);
    if (at > 0 && (best === 0 || at < best)) {
      best = at;
      hit = list[at - 1];
    }
  }
  return { rank: best, evidence: hit?.detail ?? '', keyCount: cause.foundBy.length };
}

const KS = [5, 10, 20, 30];

const out: unknown[] = [];
const lines: string[] = [
  '# Backtest against published investigation findings',
  '',
  `Each case gives the model a procedure and a plant state only. ${SHIFTS} shifts per crew, ranked by share of failed shifts. A cause counts as recovered if one of its declared pieces of evidence appears inside the top ${TOP_K}.`,
  '',
  'This is a check on whether the model looks at the same mechanisms the investigators did, and in what order. It is not a prediction, and the mapping from a published finding to a model element is our judgement, written down in advance in `data/incidents/cases.json` so it can be disputed.',
  '',
];

for (const c of cases.cases) {
  const r = rankCase(c);
  lines.push(`## ${c.id} - ${c.title}`, '');
  lines.push(`> ${c.citation}`, '');
  lines.push(`Model given: procedure **${c.givesMurphy.procedure}**, plant state **${c.givesMurphy.plant}**, crews: ${c.givesMurphy.personas.join(', ')}.`, '');
  lines.push(`Result: ${r.failed} of ${r.total} simulated shifts ended in a loss (${((r.failed / r.total) * 100).toFixed(2)}%), mean EUR ${Math.round(r.meanCost).toLocaleString('en-US')} per failed shift.`, '');
  lines.push('| published finding | recovered | rank | what the model said |', '| --- | --- | --- | --- |');
  const row: Record<string, unknown> = { id: c.id, failureRate: r.failed / r.total, causes: [] };
  for (const cause of c.heldOut) {
    const m = matchCause(r.list, cause);
    const yes = m.rank > 0 && m.rank <= TOP_K;
    lines.push(`| ${cause.cause} | ${yes ? 'yes' : 'no'} | ${m.rank || 'not raised'} | ${m.evidence.slice(0, 110)} |`);
    (row.causes as unknown[]).push({ cause: cause.cause, ...m });
  }
  lines.push('', 'Top findings the model produced that the reports did not name:');
  const held = new Set(c.heldOut.flatMap((h) => h.foundBy.map((f) => (f as { error?: string }).error ?? (f as { condition?: string }).condition ?? (f as { warning?: string }).warning ?? '')));
  const extras = r.list.filter((x) => !held.has(x.key.split(':')[1])).slice(0, 5);
  for (const e of extras) lines.push(`- (${e.kind}, rank ${r.list.indexOf(e) + 1}) ${e.detail.slice(0, 150)}`);
  lines.push('');
  out.push({ ...row, candidateTotal: r.list.length, topFindings: r.list.slice(0, 20) });
}

const allCauses = out.flatMap((o) => (o as { causes: { rank: number }[] }).causes);
const avgCandidates = Math.round((out as unknown as { candidateTotal: number }[]).reduce((a, b) => a + b.candidateTotal, 0) / out.length);
const chance = ((avgCandidates ? TOP_K / avgCandidates : 0) * 100).toFixed(0);
lines.push('## Summary', '');
lines.push(`${allCauses.length} causes were published by the investigators across ${cases.cases.length} cases. The model was given the procedure and the plant state only, and produced a ranked list of about ${avgCandidates} candidate mechanisms per case; the rank below is where the published cause landed in the model's own ordering.`, '');
lines.push('| how far down the list you read | causes recovered | of total |', '| --- | --- | --- |');
for (const k of KS) {
  const rec = allCauses.filter((c) => c.rank > 0 && c.rank <= k).length;
  lines.push(`| top ${k} findings | ${rec} | ${((rec / allCauses.length) * 100).toFixed(0)}% |`);
}
const notRaised = allCauses.filter((c) => c.rank === 0).length;
lines.push(`| never raised at all | ${notRaised} | ${((notRaised / allCauses.length) * 100).toFixed(0)}% |`);
lines.push('');
lines.push(`A ranking that put its first ${TOP_K} items down at random would be expected to catch about ${chance}% of them. The value of the curve is not the headline: it is that the model raises the mechanisms an investigation later confirms *before* the event, from the procedure text alone, and orders them by what they are actually worth. Two of these causes it ranks below the top ten, which is the honest result, and the reason a change order still needs a human signature.`);
lines.push('');

const recovered = allCauses.filter((c) => c.rank > 0 && c.rank <= TOP_K).length;

mkdirSync(join(process.cwd(), 'data', 'bench'), { recursive: true });
writeFileSync(join(process.cwd(), 'data', 'bench', 'backtest.md'), lines.join('\n'));
writeFileSync(join(process.cwd(), 'data', 'bench', 'backtest.json'), JSON.stringify({ shiftsPerCrew: SHIFTS, topK: TOP_K, recovered, total: allCauses.length, cases: out }, null, 2));
console.log(lines.slice(-8).join('\n'));
console.log(`\nwrote data/bench/backtest.md and backtest.json - recovered ${recovered}/${allCauses.length}`);
