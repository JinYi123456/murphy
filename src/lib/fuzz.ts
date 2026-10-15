import { runBatch, evaluateVariant } from '../engine/batch';
import type { BatchSummary, VariantVerdict } from '../engine/batch';
import { simulateShift } from '../engine/runner';
import { costOf } from '../engine/economics';
import { INTERVENTIONS } from '../engine/repair';
import { targetSteps } from '../engine/repair';
import { benjaminiHochberg } from '../engine/stats';
import { buildRunConfig, variantLabel } from './registry';
import type { ConsoleConfig } from './registry';
import type { RunEnvelope, SummaryDto, ShiftDto } from './dto';
import { toShiftDto, toSummaryDto } from './dto';
import { pairedBootstrap } from '../engine/stats';
import type { RunConfig } from '../engine/types';

/**
 * The service layer both the browser and the API routes call.
 *
 * Keeping one implementation means the numbers on screen are the same numbers
 * the server produced, which matters because the whole argument of this product
 * is that a claim survives being computed twice, independently.
 */

export interface FuzzOptions {
  /** how many of the worst shifts to bring back with a full record */
  collectWorst?: number;
  onProgress?: (done: number, total: number) => void;
}

export function runFuzzLocal(cfg: ConsoleConfig, opts: FuzzOptions = {}): RunEnvelope {
  const t0 = Date.now();
  const run = buildRunConfig(cfg);
  const { summary, traced } = runBatch(run, cfg.n, {
    variantId: variantLabel(cfg),
    collectWorst: opts.collectWorst ?? 12,
    onProgress: opts.onProgress,
  });
  return {
    summary: toSummaryDto(summary),
    traced: traced.map(toShiftDto),
    source: 'browser',
    ms: Date.now() - t0,
  };
}

export function replayLocal(cfg: ConsoleConfig, scn: number): ShiftDto {
  const run = buildRunConfig(cfg);
  return toShiftDto(simulateShift(run, scn, { trace: true, sampleEveryS: 10 }));
}

export interface CandidateTrial {
  control: { id: string; label: string; tier: string; describe: string; annualCostEur: number; addedSeconds: number };
  targets: string[];
  summary?: SummaryDto;
  verdict?: VariantVerdict;
  error?: string;
}

/**
 * The repair loop.
 *
 * Every control the current procedure admits is tested against the baseline on
 * the same scenario indices, then the raw p-values go through false discovery
 * correction, because testing twelve ideas and keeping the best is exactly how
 * you manufacture a result that does not exist. Survivors are then stacked and
 * re-tested as one revised procedure: controls interact, and a loop that ignored
 * that would sell a saving twice.
 */
export async function runRepairLoop(
  cfg: ConsoleConfig,
  n: number,
  onEvent?: (e: { phase: string; message: string; trial?: CandidateTrial; done?: number; total?: number }) => void,
): Promise<{ baseline: SummaryDto; trials: CandidateTrial[]; stacked: { summary: SummaryDto; verdict: VariantVerdict | null; controls: string[] } | null }> {
  const baseRun: RunConfig = buildRunConfig(cfg);
  const base = runBatch(baseRun, n, { variantId: variantLabel(cfg) }).summary;
  onEvent?.({ phase: 'baseline', message: `baseline ${cfg.n} shifts, failure ${(base.failureRate * 100).toFixed(2)}%`, done: 0, total: INTERVENTIONS.length });

  const trials: CandidateTrial[] = [];
  const procedure = baseRun.procedure;
  let i = 0;
  for (const int of INTERVENTIONS) {
    i++;
    const targets = targetSteps(int, procedure).map((s) => s.id);
    const appliesToSomething = targets.length > 0 || int.effect.plant !== undefined || int.effect.startLevelFrac !== undefined;
    const trial: CandidateTrial = {
      control: {
        id: int.id, label: int.label, tier: int.tier, describe: int.describe,
        annualCostEur: int.effect.annualCostEur ?? 0, addedSeconds: int.effect.addedSeconds ?? 0,
      },
      targets,
    };
    if (!appliesToSomething) {
      trial.error = 'no step in this procedure admits it';
      trials.push(trial);
      onEvent?.({ phase: 'skip', message: `${int.id}: ${trial.error}`, trial, done: i, total: INTERVENTIONS.length });
      continue;
    }
    const nextCfg: ConsoleConfig = { ...cfg, controls: [...cfg.controls, int.id], n };
    const candRun = buildRunConfig(nextCfg);
    const cand = runBatch(candRun, n, { variantId: variantLabel(nextCfg) }).summary;
    trial.summary = toSummaryDto(cand);
    trial.verdict = evaluateVariant(base, cand, { annualCostEur: int.effect.annualCostEur ?? 0 });
    trials.push(trial);
    onEvent?.({
      phase: 'trial',
      message: `${int.id}: failure ${(cand.failureRate * 100).toFixed(2)}% (${((cand.failureRate - base.failureRate) * 100).toFixed(2)} pts), net EUR ${Math.round(trial.verdict.netEur).toLocaleString('en-US')} ${trial.verdict.accepted ? 'ACCEPTED' : 'rejected'}`,
      trial, done: i, total: INTERVENTIONS.length,
    });
  }

  // false discovery control across everything we just tested
  const tested = trials.filter((t) => t.verdict && t.verdict.failure.delta < 0);
  const ps = tested.map((t) => (t.verdict as VariantVerdict).failure.oneSidedRisk);
  const keep = benjaminiHochberg(ps, 0.05);
  tested.forEach((t, idx) => {
    if (!keep[idx] && t.verdict) {
      t.verdict = { ...t.verdict, accepted: false, reasons: [...t.verdict.reasons, 'did not survive false discovery correction across the whole candidate set'] };
    }
  });

  const accepted = tested.filter((t) => t.verdict?.accepted).map((t) => t.control.id);
  let stacked = null;
  if (accepted.length) {
    const stackCfg: ConsoleConfig = { ...cfg, controls: [...cfg.controls, ...accepted], n };
    const stackRun = buildRunConfig(stackCfg);
    const s = runBatch(stackRun, n, { variantId: variantLabel(stackCfg) }).summary;
    const cost = trials.filter((t) => accepted.includes(t.control.id)).reduce((a, b) => a + b.control.annualCostEur, 0);
    const verdict = evaluateVariant(base, s, { annualCostEur: cost });
    stacked = { summary: toSummaryDto(s), verdict, controls: accepted };
    onEvent?.({ phase: 'stack', message: `stacked ${accepted.join(', ')}: failure ${(s.failureRate * 100).toFixed(2)}%, net EUR ${Math.round(verdict.netEur).toLocaleString('en-US')}` });
  }

  return { baseline: toSummaryDto(base), trials, stacked };
}

/** Cost of one shift, exposed for the black box read-out. */
export function shiftCost(cfg: ConsoleConfig, scn: number): number {
  const run = buildRunConfig(cfg);
  const r = simulateShift(run, scn);
  return costOf(run.procedure.twin, r.outcome, r.peak, run.plant.product ?? 'default').totalEur;
}

/** Distribution of the money, for the tail chart. */
export function lossSpectrum(base: BatchSummary, cand: BatchSummary) {
  return {
    baseCi: pairedBootstrap(base.costs, cand.costs, { seed: 31337 }),
  };
}

export type { SummaryDto, RunEnvelope };
