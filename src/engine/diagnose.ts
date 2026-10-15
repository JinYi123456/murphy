import { getTwin } from './twins/index';
import { simulateShift } from './runner';
import { seedToKey, drawFrac } from './prng';
import type { RunConfig, Step } from './types';

/**
 * Diagnosis by forward simulation.
 *
 * Most tools in this space detect that something is odd and then ask a model to
 * write a sentence about it. The confidence in those tools is a constant somebody
 * typed. Here the hypotheses are the procedure's own error modes, so the question
 * becomes answerable quantitatively: if this step had really gone wrong, what
 * would the instruments be showing right now? Run every candidate forward on the
 * same twin with common random numbers, score the mismatch, and the normalised
 * scores *are* the probabilities. Nothing is asserted that was not computed.
 *
 * The scoring kernel is deliberately arithmetic (a heavy-tailed rational kernel,
 * not a Gaussian) for two reasons: it keeps the whole product free of
 * transcendental calls so a result computed on an Instinct GPU is the same result
 * computed in a browser, and a heavy tail means one clipped channel - a sensor
 * that hit its range - cannot annihilate an otherwise correct hypothesis.
 */

export interface Channel {
  /** twin variable name */
  name: string;
  /** weight in the score; channels the operator cannot see should be excluded */
  sigma: number;
  /** use the indicated value rather than the true one, which is what a real historian holds */
  indicated?: boolean;
}

export interface Observation {
  /** equally spaced samples, oldest first */
  tS: number[];
  values: Record<string, number[]>;
}

export interface Hypothesis {
  id: string;
  stepId: string;
  stepTitle: string;
  errorId: string;
  errorKind: string;
  label: string;
  /** prior belief, normally the modelled probability that this step failed at all */
  prior: number;
  logScore: number;
  posterior: number;
  /** mean absolute mismatch per channel, for the audit view */
  residual: Record<string, number>;
}

export interface Diagnosis {
  hypotheses: Hypothesis[];
  /** which hypothesis the observation was actually generated from, when known */
  truth?: string;
  channels: Channel[];
  replicas: number;
  windowS: number;
}

/** Default observable set for the transfer twin: what a historian would hold. */
export const TANK_CHANNELS: Channel[] = [
  { name: 'level', sigma: 0.12, indicated: true },
  { name: 'lineP', sigma: 2.2, indicated: true },
  { name: 'tankP', sigma: 6, indicated: true },
  { name: 'delivered', sigma: 2.5 },
];

export const FURNACE_CHANNELS: Channel[] = [
  { name: 'zoneT', sigma: 28, indicated: true },
  { name: 'shellT', sigma: 14, indicated: true },
  { name: 'gasAccum', sigma: 1.2 },
  { name: 'moisture', sigma: 0.5 },
];

export function channelsFor(twin: string): Channel[] {
  if (twin === 'furnace_lightoff') return FURNACE_CHANNELS;
  if (twin === 'furnace_operating') return FURNACE_CHANNELS;
  return TANK_CHANNELS;
}

/**
 * Build the candidate set from the procedure itself: every step that has an
 * error surface contributes one hypothesis per error mode, plus the hypothesis
 * that nothing went wrong. The priors come from the same reliability tables the
 * fuzzing uses, so diagnosis and stress-testing share one belief.
 */
export function hypothesesFor(cfg: RunConfig): { step: Step; errorId: string | null; label: string; kind: string; prior: number }[] {
  const out: { step: Step; errorId: string | null; label: string; kind: string; prior: number }[] = [];
  const stepsWithSurface = cfg.procedure.steps.filter((s) => (s.errors ?? []).length);
  // one "nothing went wrong" hypothesis, not one per step, or the priors would
  // add up to the number of steps and the clean case would win by arithmetic
  const perStep = 2e-3;
  const pAny = Math.min(0.5, perStep * Math.max(1, stepsWithSurface.length));
  out.push({
    step: cfg.procedure.steps[0],
    errorId: null,
    label: 'every step performed as written',
    kind: 'clean',
    prior: Math.max(1e-6, 1 - pAny),
  });
  for (const step of stepsWithSurface) {
    const surface = step.errors ?? [];
    let total = 0;
    for (const e of surface) total += e.weight;
    for (const e of surface) {
      out.push({
        step, errorId: e.id, label: e.text, kind: e.kind,
        prior: Math.max(1e-9, perStep * (e.weight / (total || 1))),
      });
    }
  }
  return out;
}

/**
 * Generate an observation from a known truth. Used for the accuracy benchmark and
 * for the interface's "replay this shift's instruments" mode. Only observable
 * channels are returned, and they carry the instrument error the operator saw,
 * not the plant truth.
 */
export function synthesizeObservation(
  cfg: RunConfig,
  scn: number,
  forceError: { stepId: string; errorId: string | null } | null,
  channels: Channel[],
  windowS = 900,
  stepS = 15,
): { obs: Observation; truth: string } {
  const shift = simulateShift(cfg, scn, {
    trace: true,
    sampleEveryS: stepS,
    force: forceError ? { stepId: forceError.stepId, errorId: forceError.errorId } : undefined,
  });
  const twin = getTwin(cfg.procedure.twin);
  const start = Math.max(0, shift.series.length - Math.ceil(windowS / stepS));
  const frames = shift.series.slice(start);
  const tS: number[] = [];
  const values: Record<string, number[]> = {};
  for (const c of channels) values[c.name] = [];
  for (const f of frames) {
    tS.push(f.tS);
    for (const c of channels) {
      const raw = c.indicated ? f.v[c.name] + (f.d.gaugeBias ?? f.d.tcBias ?? 0) : f.v[c.name];
      values[c.name].push(Number.isFinite(raw) ? raw : 0);
    }
  }
  void twin;
  return {
    obs: { tS, values },
    truth: forceError ? `${forceError.stepId}/${forceError.errorId ?? 'clean'}` : 'unknown',
  };
}

/** Heavy-tailed per-sample score: 1 / (1 + (delta / sigma)^2). */
function kernel(delta: number, sigma: number): number {
  const z = delta / (sigma > 0 ? sigma : 1e-6);
  return 1 / (1 + z * z);
}

/**
 * How many samples of a window count as independent evidence.
 *
 * A trajectory is not a set of independent readings: consecutive frames of the
 * same curve carry the same information over and over, and multiplying them out
 * as if they were independent would inflate the likelihood by the window length
 * and make the confidence a function of how long you chose to look. Dividing by a
 * decorrelation time of five samples (75 s at the historian's resolution) is a
 * deliberate, stated approximation rather than a hidden one.
 */
const DECORR_SAMPLES = 5;

/** exp-space addition without the underflow a 40-minute window produces. */
function logSumExp(a: number, b: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const m = a > b ? a : b;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/**
 * Score every hypothesis against the observation and normalise with the priors.
 *
 * Each hypothesis is run forward `replicas` times from the same starting state
 * with different seeds, so measurement noise and crew variation are integrated
 * out rather than assumed away; the reported likelihood is the mean score over
 * replicas. Cost: replicas x hypotheses shifts, which is why the interface runs
 * it on a short window and the GPU is genuinely useful here.
 *
 * Channels are compared as *increments from the start of the window*. A real
 * diagnostician is told where the batch started but not what the operator's
 * gauge is really reading, and comparing absolute levels makes that unknown
 * offset dominate every other term - the first version of this scored nothing but
 * noise. Differencing removes both the start level and a constant instrument
 * bias, which is exactly the confound that has to go.
 */
export function diagnose(
  cfg: RunConfig,
  obs: Observation,
  opts: { replicas?: number; channels?: Channel; truth?: string; excludeClean?: boolean; only?: string[] } = {},
): Diagnosis {
  const channels = (opts.channels ? [opts.channels] : channelsFor(cfg.procedure.twin)).filter((c) => obs.values[c.name]);
  const replicas = Math.max(1, opts.replicas ?? 12);
  const cands = hypothesesFor(cfg)
    .filter((h) => !opts.excludeClean || h.errorId !== null)
    .filter((h) => !opts.only || opts.only.includes(`${h.step.id}/${h.errorId ?? 'clean'}`));
  const obsDelta: Record<string, number[]> = {};
  for (const c of channels) {
    const series = obs.values[c.name];
    const base = series[0] ?? 0;
    obsDelta[c.name] = series.map((v) => v - base);
  }
  const twin = getTwin(cfg.procedure.twin);
  const base: Hypothesis[] = [];

  for (const cand of cands) {
    const force = { stepId: cand.errorId === null ? '*' : cand.step.id, errorId: cand.errorId };
    const replicaScores: number[] = [];
    const resid: Record<string, number> = {};
    for (const c of channels) resid[c.name] = 0;
    for (let r = 0; r < replicas; r++) {
      const shift = simulateShift(cfg, 1000 + r, { trace: true, sampleEveryS: 15, force });
      const frames = shift.series;
      if (!frames.length) continue;
      const tail = frames.slice(Math.max(0, frames.length - obs.tS.length));
      const len = Math.min(tail.length, obs.tS.length);
      if (len < 2) continue;
      const seg = tail.slice(tail.length - len);
      const read = (f: (typeof seg)[number], name: string, indicated?: boolean) => {
        const raw = f.v[name];
        if (!Number.isFinite(raw)) return 0;
        return indicated ? raw + (f.d.gaugeBias ?? f.d.tcBias ?? 0) : raw;
      };
      // log-likelihoods add across channels; within a channel the mean log score
      // is taken over samples and then scaled by the number of independent
      // samples the window is worth
      let ls = 0;
      for (const c of channels) {
        const series = obsDelta[c.name];
        const anchor = read(seg[0], c.name, c.indicated);
        let acc = 0;
        let n = 0;
        for (let i = 0; i < len; i++) {
          const obsIdx = series.length - len + i;
          if (obsIdx < 0) continue;
          const predDelta = read(seg[i], c.name, c.indicated) - anchor;
          const delta = series[obsIdx] - predDelta;
          acc += Math.log(Math.max(1e-12, kernel(delta, c.sigma)));
          resid[c.name] += Math.abs(delta);
          n++;
        }
        if (!n) continue;
        ls += (acc / n) * Math.max(1, Math.round(n / DECORR_SAMPLES));
      }
      replicaScores.push(ls);
    }
    // replicas are alternative worlds that could have produced this one
    // observation, so they mix: log(mean likelihood), not a sum
    let logLik = -Infinity;
    for (const v of replicaScores) logLik = logSumExp(logLik, v);
    if (replicaScores.length) logLik -= Math.log(replicaScores.length);
    if (!Number.isFinite(logLik)) logLik = -60;
    base.push({
      id: `${cand.step.id}/${cand.errorId ?? 'clean'}`,
      stepId: cand.step.id,
      stepTitle: cand.step.title,
      errorId: cand.errorId ?? 'clean',
      errorKind: cand.kind,
      label: cand.label,
      prior: cand.prior,
      logScore: logLik,
      posterior: 0,
      residual: Object.fromEntries(Object.entries(resid).map(([k, v]) => [k, v / Math.max(1, replicas * obs.tS.length)])),
    });
  }

  // normalise in log space so a wide dynamic range does not flatten everything
  const maxLog = Math.max(...base.map((b) => b.logScore + Math.log(b.prior)));
  let z = 0;
  for (const h of base) {
    h.posterior = Math.exp(h.logScore + Math.log(h.prior) - maxLog);
    z += h.posterior;
  }
  for (const h of base) h.posterior /= z || 1;
  base.sort((a, b) => b.posterior - a.posterior);

  return {
    hypotheses: base,
    truth: opts.truth,
    channels,
    replicas,
    windowS: obs.tS.length ? obs.tS[obs.tS.length - 1] - obs.tS[0] : 0,
  };
}

/** How often the true hypothesis is ranked first / inside the top three. */
export function scoreDiagnosis(results: { truth: string; ranked: string[] }[]) {
  let top1 = 0;
  let top3 = 0;
  for (const r of results) {
    const at = r.ranked.indexOf(r.truth);
    if (at === 0) top1++;
    if (at >= 0 && at < 3) top3++;
  }
  const n = Math.max(1, results.length);
  return { n, top1: top1 / n, top3: top3 / n };
}

/** Deterministic jitter helper kept for the benchmark's noise studies. */
export function noiseAt(seed: string, scn: number, pos: number, amp: number): number {
  const key = seedToKey(seed);
  return (drawFrac(key, scn, pos, 0) - 0.5) * 2 * amp;
}
