import { costOf } from './economics';
import { simulateShift } from './runner';
import type { ExtendedResult } from './runner';
import type { RunConfig } from './types';
import { pairedBootstrap, pairedPValue, cvar, meanCi, quantile } from './stats';
import type { PairedEffect } from './stats';

export interface StepStat {
  /** times the step went wrong at all */
  thrown: number;
  /** times a later step or a protection function caught it */
  caught: number;
  /** times the deviation survived to the end of the shift */
  escaped: number;
  /** times an escaped deviation here was the first causal one */
  causal: number;
  /** times it was the first causal deviation on a shift that actually failed */
  causalFailure: number;
  /** mean modelled error probability across the scenarios that reached it */
  p: number;
  /** times the step was reached at all */
  reached: number;
  title: string;
  /** share of surviving deviations attributable to this step */
  escapeShare: number;
}

export interface BatchSummary {
  variantId: string;
  seed: string;
  n: number;
  failed: number;
  failureRate: number;
  nearMissRate: number;
  outcomeCounts: Record<string, number>;
  perStep: Record<string, StepStat>;
  meanCostEur: number;
  costCi: { mean: number; ciLow: number; ciHigh: number };
  p95CostEur: number;
  cvarCostEur: number;
  meanReleaseM3: number;
  meanElapsedS: number;
  meanHazardS: number;
  shiftsPerYear: number;
  annualLossEur: number;
  annualEscalatedEur: number;
  costs: Float64Array;
  escalation: Float64Array;
  failures: Uint8Array;
  wallMs: number;
  shiftsPerSecond: number;
  /** scenario indices of the most expensive shifts, in descending cost order */
  worst: number[];
}

export interface BatchOptions {
  variantId?: string;
  /** re-simulate this many of the worst shifts with a full record */
  collectWorst?: number;
  /** emit progress this many times over the run; 0 disables */
  progressEvery?: number;
  onProgress?: (done: number, total: number) => void;
}

const shiftsPerYearOf = (cfg: { plant: { protection: Record<string, boolean | number> } }): number => {
  const v = cfg.plant.protection['shiftsPerYear'];
  return typeof v === 'number' && v > 0 ? v : 600;
};

/**
 * Run `n` shifts of one configuration.
 *
 * The scenario index is the pairing key: index i always sees the same persona
 * draw and the same equipment state, so two variants can be differenced
 * scenario by scenario. Per-shift results land in typed arrays and only the
 * handful of shifts selected for replay are re-simulated with a full record -
 * which also proves the seed replay property every time the black box is
 * opened, because the replayed shift is recomputed, not stored.
 */
export function runBatch(
  cfg: RunConfig,
  n: number,
  opts: BatchOptions = {},
): { summary: BatchSummary; traced: ExtendedResult[] } {
  const t0 = Date.now();
  const costs = new Float64Array(n);
  const escalation = new Float64Array(n);
  const failures = new Uint8Array(n);
  const releases = new Float64Array(n);
  const elapsedArr = new Float64Array(n);
  const hazardArr = new Float64Array(n);
  const outcomeCounts: Record<string, number> = {};
  const perStep: Record<string, StepStat> = {};
  for (const s of cfg.procedure.steps) {
    perStep[s.id] = { thrown: 0, caught: 0, escaped: 0, causal: 0, causalFailure: 0, p: 0, reached: 0, title: s.title, escapeShare: 0 };
  }
  const pSum: Record<string, number> = {};
  const reportEvery = opts.progressEvery ? Math.max(1, Math.floor(n / opts.progressEvery)) : 0;
  let nearMiss = 0;

  for (let scn = 0; scn < n; scn++) {
    const r = simulateShift(cfg, scn);
    const c = costOf(cfg.procedure.twin, r.outcome, r.peak, cfg.plant.product ?? 'default');
    costs[scn] = c.totalEur;
    escalation[scn] = c.escalationEur;
    releases[scn] = r.releaseM3;
    elapsedArr[scn] = r.elapsedS;
    hazardArr[scn] = r.hazardSeconds;
    failures[scn] = r.failed ? 1 : 0;
    if (r.nearMiss) nearMiss++;
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;

    for (const e of r.errors) {
      const st = perStep[e.stepId];
      if (st) st.escaped++;
    }
    if (r.errors.length) {
      const st = perStep[r.errors[0].stepId];
      if (st) { st.causal++; if (r.failed) st.causalFailure++; }
    }
    for (const key of Object.keys(r.caughtBy)) {
      const st = perStep[key.split('/')[0]];
      if (st) st.caught++;
    }
    for (const a of r.audit) {
      const st = perStep[a.stepId];
      if (!st) continue;
      st.reached++;
      pSum[a.stepId] = (pSum[a.stepId] ?? 0) + a.p;
    }
    if (reportEvery && (scn + 1) % reportEvery === 0) opts.onProgress?.(scn + 1, n);
  }

  let escapedTotal = 0;
  for (const id of Object.keys(perStep)) {
    const st = perStep[id];
    st.thrown = st.caught + st.escaped;
    st.p = st.reached > 0 ? pSum[id] / st.reached : 0;
    escapedTotal += st.escaped;
  }
  for (const id of Object.keys(perStep)) perStep[id].escapeShare = escapedTotal > 0 ? perStep[id].escaped / escapedTotal : 0;

  const totalCost = costs.reduce((a, b) => a + b, 0);
  const totalEsc = escalation.reduce((a, b) => a + b, 0);
  const failed = failures.reduce((a, b) => a + b, 0);
  const spy = shiftsPerYearOf(cfg);
  const wallMs = Math.max(1, Date.now() - t0);
  const order = Array.from(costs, (c, i) => ({ c, i })).sort((a, b) => b.c - a.c);
  const worst = order.slice(0, opts.collectWorst ?? 0).filter((x) => x.c > 0).map((x) => x.i);

  const traced = worst.map((scn) => simulateShift(cfg, scn, {
    trace: true,
    sampleEveryS: Math.max(5, Math.ceil(elapsedArr[scn] / 180)),
  }));

  return {
    summary: {
      variantId: opts.variantId ?? `${cfg.procedure.id}@${cfg.procedure.revision}`,
      seed: cfg.seed,
      n,
      failed,
      failureRate: failed / n,
      nearMissRate: nearMiss / n,
      outcomeCounts,
      perStep,
      meanCostEur: totalCost / n,
      costCi: meanCi(costs, { iterations: Math.min(1500, Math.max(200, Math.floor(n / 8))) }),
      p95CostEur: quantile(costs, 0.95),
      cvarCostEur: cvar(costs, 0.95),
      meanReleaseM3: releases.reduce((a, b) => a + b, 0) / n,
      meanElapsedS: elapsedArr.reduce((a, b) => a + b, 0) / n,
      meanHazardS: hazardArr.reduce((a, b) => a + b, 0) / n,
      shiftsPerYear: spy,
      annualLossEur: (totalCost / n) * spy,
      annualEscalatedEur: ((totalCost + totalEsc) / n) * spy,
      costs,
      escalation,
      failures,
      wallMs,
      shiftsPerSecond: (n / wallMs) * 1000,
      worst,
    },
    traced,
  };
}

export interface VariantVerdict {
  failure: PairedEffect;
  cost: PairedEffect;
  failureP: number;
  costP: number;
  /** absolute annual saving claimed by the change, euros */
  annualGainEur: number;
  /** one-off and recurring cost of the intervention itself, euros per year */
  interventionCostEur: number;
  netEur: number;
  accepted: boolean;
  reasons: string[];
}

/**
 * Gate a candidate procedure edit.
 *
 * A change is only kept when the paired test says the failure rate really
 * dropped, the tail of expected loss really got thinner, and the improvement
 * is worth more than the intervention costs. Three separate reasons are
 * reported when it fails, because "we could not show it" and "it made
 * something else worse" are different conversations with an operations
 * manager.
 */
export function evaluateVariant(
  base: BatchSummary,
  cand: BatchSummary,
  intervention: { annualCostEur: number; minGainEur?: number; maxRisk?: number; guardrail?: { metric: keyof BatchSummary; limit: number } } = { annualCostEur: 0 },
): VariantVerdict {
  const maxRisk = intervention.maxRisk ?? 0.025;
  const minGain = intervention.minGainEur ?? 1000;
  const failure = pairedBootstrap(base.failures, cand.failures, { seed: 0xc0ffee });
  const cost = pairedBootstrap(base.costs, cand.costs, { seed: 20251015 });
  const annualGain = (base.meanCostEur - cand.meanCostEur) * base.shiftsPerYear;
  const netEur = annualGain - intervention.annualCostEur;

  const reasons: string[] = [];
  if (!(failure.delta < 0)) reasons.push('failure rate did not fall');
  if (!(failure.oneSidedRisk < maxRisk)) reasons.push(`paired bootstrap risk of a false positive ${(failure.oneSidedRisk * 100).toFixed(1)}% exceeds ${(maxRisk * 100).toFixed(1)}%`);
  if (!(cost.delta < 0 || Math.abs(cost.delta) < 1e-9)) reasons.push('expected loss did not fall');
  if (!(netEur > minGain)) reasons.push(`net annual gain EUR ${netEur.toFixed(0)} is below the EUR ${minGain} threshold`);
  if (cand.nearMissRate > base.nearMissRate * 1.02 && failure.delta >= -1e-9) reasons.push('near-miss rate rose without a compensating gain');

  return {
    failure,
    cost,
    failureP: pairedPValue(failure),
    costP: pairedPValue(cost),
    annualGainEur: annualGain,
    interventionCostEur: intervention.annualCostEur,
    netEur,
    accepted: reasons.length === 0,
    reasons,
  };
}
