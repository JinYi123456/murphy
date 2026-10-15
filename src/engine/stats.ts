/**
 * Statistics for comparing procedure variants.
 *
 * Variants are compared as a paired test. Because a step keeps a stable random
 * stream slot (see runner.slotFor) and a scenario keeps its index, scenario i
 * of the baseline and scenario i of the candidate share the same persona,
 * equipment state and the same draws for every step they have in common. The
 * variance of the difference is then far smaller than the variance of either
 * arm, which is what makes a one-percentage-point improvement measurable at a
 * batch size a laptop can run.
 */

export interface PairedEffect {
  /** mean of candidate minus baseline; negative is an improvement for losses */
  delta: number;
  baseMean: number;
  candMean: number;
  ciLow: number;
  ciHigh: number;
  /** fraction of bootstrap replicates that landed on the wrong side of zero */
  oneSidedRisk: number;
  iterations: number;
}

/** Deterministic 32-bit integer hash driving the resampling, so CI is reproducible. */
function bootRand(seed: number, i: number, lane: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Paired percentile bootstrap of the mean difference. */
export function pairedBootstrap(
  base: ArrayLike<number>,
  cand: ArrayLike<number>,
  opts: { iterations?: number; seed?: number; confidence?: number } = {},
): PairedEffect {
  const n = Math.min(base.length, cand.length);
  const iterations = opts.iterations ?? 2000;
  const seed = opts.seed ?? 0x5eed1;
  const conf = opts.confidence ?? 0.95;
  if (n === 0) {
    return { delta: 0, baseMean: 0, candMean: 0, ciLow: 0, ciHigh: 0, oneSidedRisk: 1, iterations };
  }
  let sb = 0;
  let sc = 0;
  for (let i = 0; i < n; i++) { sb += base[i]; sc += cand[i]; }
  const baseMean = sb / n;
  const candMean = sc / n;
  const delta = candMean - baseMean;

  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) diffs[i] = cand[i] - base[i];

  const means = new Float64Array(iterations);
  let wrongSide = 0;
  for (let b = 0; b < iterations; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(bootRand(seed, b, i) * n);
      acc += diffs[j];
    }
    means[b] = acc / n;
    if (delta < 0 ? means[b] > 0 : means[b] < 0) wrongSide++;
  }
  const sorted = Array.from(means).sort((a, c) => a - c);
  const lo = sorted[Math.floor(((1 - conf) / 2) * iterations)];
  const hi = sorted[Math.min(iterations - 1, Math.floor((1 - (1 - conf) / 2) * iterations))];
  return { delta, baseMean, candMean, ciLow: lo, ciHigh: hi, oneSidedRisk: wrongSide / iterations, iterations };
}

/** Two-sided percentile bootstrap of a single arm. */
export function meanCi(
  values: ArrayLike<number>,
  opts: { iterations?: number; seed?: number; confidence?: number } = {},
): { mean: number; ciLow: number; ciHigh: number } {
  const n = values.length;
  const iterations = opts.iterations ?? 1500;
  const seed = opts.seed ?? 0x5eed2;
  const conf = opts.confidence ?? 0.95;
  if (n === 0) return { mean: 0, ciLow: 0, ciHigh: 0 };
  let s = 0;
  for (let i = 0; i < n; i++) s += values[i];
  const means = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += values[Math.floor(bootRand(seed, b, i) * n)];
    means[b] = acc / n;
  }
  const sorted = Array.from(means).sort((a, c) => a - c);
  return {
    mean: s / n,
    ciLow: sorted[Math.floor(((1 - conf) / 2) * iterations)],
    ciHigh: sorted[Math.min(iterations - 1, Math.floor((1 - (1 - conf) / 2) * iterations))],
  };
}

export function quantile(values: Float64Array | number[], q: number): number {
  if (values.length === 0) return 0;
  const a = Array.from(values).sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.floor(q * a.length)));
  return a[i];
}

/** Conditional value at risk: the mean of the worst tail, which is where a real budget decision lives. */
export function cvar(values: Float64Array | number[], alpha = 0.95): number {
  if (values.length === 0) return 0;
  const thresh = quantile(values, alpha);
  let acc = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= thresh) { acc += values[i]; n++; }
  }
  return n ? acc / n : 0;
}

/**
 * Benjamini-Hochberg false discovery rate control.
 * Candidate fixes are tested together; without correction the sheer number of
 * attempts would eventually surface something "significant" by luck alone.
 */
export function benjaminiHochberg(pValues: number[], fdr = 0.05): boolean[] {
  const m = pValues.length;
  const keep = new Array(m).fill(false);
  if (m === 0) return keep;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let maxK = -1;
  for (let k = 0; k < m; k++) {
    if (order[k].p <= ((k + 1) / m) * fdr) maxK = k;
  }
  for (let k = 0; k <= maxK; k++) keep[order[k].i] = true;
  return keep;
}

/** Normal-approximation tail for a paired effect, from the bootstrap spread. */
export function pairedPValue(effect: PairedEffect): number {
  const sd = (effect.ciHigh - effect.ciLow) / (2 * 1.96);
  if (!(sd > 0)) return effect.oneSidedRisk;
  const z = effect.delta / sd;
  return Math.max(1e-10, Math.min(0.9999, 2 * tailAbove(Math.abs(z))));
}

/** Upper tail of the standard normal, A&S 26.2.17 rational approximation. */
function tailAbove(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const pdf = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return pdf * poly;
}
