import benchStore from '../../data/bench/diagnosis.json';
import { buildRunConfig } from './registry';
import type { ConsoleConfig } from './registry';
import { simulateShift } from '../engine/runner';
import { channelsFor, diagnose } from '../engine/diagnose';
import type { Channel, Diagnosis, Observation } from '../engine/diagnose';
import { getTwin } from '../engine/twins/index';

/**
 * Turn one recorded shift into a question an instrument face can answer.
 *
 * The recording already knows what went wrong, because the simulator wrote it.
 * That is the point: the answer is held back from the diagnostician and given to
 * the reader afterwards, so the ranking can be checked instead of admired. The
 * same routine, run over every mode of a procedure, is what produced the
 * observability and identifiability figures in the evidence view.
 */

export interface DiagnosisCase {
  scn: number;
  /** stepId/errorId of the failure this window really came from */
  truth: string;
  truthLabel: string;
  truthKind: string;
  truthAtS: number;
  outcome: string;
  windowS: number;
  stepS: number;
  replicas: number;
  obs: Observation;
  channels: Channel[];
  /** mean instrument movement the true failure causes, in sigmas per sample */
  divergence: number;
  /** false when the divergence is below what the historian can resolve */
  visible: boolean;
  diagnosis: Diagnosis;
  /** rank of the truth in the published ranking, 0-based; -1 if excluded */
  rank: number;
  ms: number;
}

/** Below this, the difference between the failure and a clean shift is smaller
 *  than the scatter the instruments already show. */
export const RESOLUTION = 0.05;

interface Frame {
  tS: number;
  v: Record<string, number>;
  d: Record<string, number>;
}

function read(f: Frame, c: Channel): number {
  const raw = f.v[c.name];
  if (!Number.isFinite(raw)) return 0;
  return c.indicated ? raw + (f.d.gaugeBias ?? f.d.tcBias ?? 0) : raw;
}

function increments(series: Frame[], c: Channel): number[] {
  const base = series.length ? read(series[0], c) : 0;
  return series.map((f) => read(f, c) - base);
}

/**
 * Mean absolute difference between this failure and the same crew on the same
 * day with nothing missed, per channel, normalised by that channel's sigma.
 */
function divergenceVsClean(
  run: Parameters<typeof simulateShift>[0],
  scn: number,
  truth: { stepId: string; errorId: string },
  channels: Channel[],
  stepS: number,
  frames: number,
): number {
  const bad = simulateShift(run, scn, { trace: true, sampleEveryS: stepS, force: truth });
  const clean = simulateShift(run, scn, { trace: true, sampleEveryS: stepS, force: { stepId: '*', errorId: null } });
  const len = Math.min(bad.series.length, clean.series.length, frames);
  if (len < 3) return 0;
  const fs = bad.series.slice(bad.series.length - len);
  const cs = clean.series.slice(clean.series.length - len);
  let acc = 0;
  let n = 0;
  for (const c of channels) {
    const fv = increments(fs, c);
    const cv = increments(cs, c);
    for (let i = 1; i < len; i++) {
      acc += Math.abs(fv[i] - cv[i]) / c.sigma;
      n++;
    }
  }
  return n ? acc / n : 0;
}

export function analyseShift(
  cfg: ConsoleConfig,
  scn: number,
  errorIndex: number,
  opts: { windowS?: number; stepS?: number; replicas?: number } = {},
): DiagnosisCase {
  const t0 = Date.now();
  const run = buildRunConfig(cfg);
  const stepS = opts.stepS ?? 15;
  const windowS = opts.windowS ?? 2400;
  const replicas = opts.replicas ?? 6;
  const channels = channelsFor(run.procedure.twin);

  const shift = simulateShift(run, scn, { trace: true, sampleEveryS: stepS });
  const err = shift.errors[Math.max(0, Math.min(shift.errors.length - 1, errorIndex))];
  if (!err) throw new Error(`shift ${scn} recorded no error to diagnose`);

  const frames = Math.ceil(windowS / stepS);
  const len = Math.min(shift.series.length, frames);
  const tail = shift.series.slice(shift.series.length - len);
  const obs: Observation = { tS: tail.map((f) => f.tS), values: {} };
  for (const c of channels) obs.values[c.name] = tail.map((f) => read(f, c));

  const divergence = divergenceVsClean(run, scn, { stepId: err.stepId, errorId: err.errorId }, channels, stepS, frames);
  const diagnosis = diagnose(run, obs, { replicas, truth: `${err.stepId}/${err.errorId}` });
  const rank = diagnosis.hypotheses.findIndex((h) => h.id === `${err.stepId}/${err.errorId}`);

  const twin = getTwin(run.procedure.twin);
  const surface = run.procedure.steps.find((s) => s.id === err.stepId)?.errors?.find((e) => e.id === err.errorId);
  void twin;

  return {
    scn,
    truth: `${err.stepId}/${err.errorId}`,
    truthLabel: surface?.text ?? err.kind,
    truthKind: err.kind,
    truthAtS: err.atS,
    outcome: shift.outcome,
    windowS,
    stepS,
    replicas,
    obs,
    channels,
    divergence,
    visible: divergence > RESOLUTION,
    diagnosis,
    rank,
    ms: Date.now() - t0,
  };
}

/** One measured procedure/plant pair from the diagnosis benchmark. */
export interface BenchCase {
  key: string;
  procedure: string;
  plant: string;
  twin: string;
  persona: string;
  method: string;
  channels: string[];
  windowS: number;
  stepS: number;
  replicas: number;
  threshold: number;
  errorModes: number;
  observable: number;
  observableShare: number;
  unobservable: string[];
  trials: number;
  top1: number;
  top3: number
  chanceTop1: number;
  lift: number;
  divergence: { id: string; label: string; kind: string; divergence: number }[];
  rows: { truth: string; rank: number; posterior: number; top: string }[];
}

/**
 * The measured figures for exactly this procedure in exactly this plant state.
 *
 * Null when that pair has not been benchmarked. The interface shows nothing in
 * that case rather than borrowing a number from a different process, which is how
 * a furnace's observability would end up printed under a tank transfer.
 */
export function benchCase(procedureId: string, plantId: string): BenchCase | null {
  const store = benchStore as { cases?: Record<string, BenchCase> };
  return store.cases?.[`${procedureId}/${plantId}`] ?? null;
}
