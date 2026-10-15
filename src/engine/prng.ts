/**
 * Counter-based deterministic RNG (Philox-4x32-10), implemented with 32-bit
 * integer arithmetic decomposed so that every intermediate stays exactly
 * representable in IEEE-754 double.
 *
 * The same algorithm is re-implemented in the PyTorch engine with int64
 * tensor ops. Because both sides use only exact integer operations and an
 * exact u32/2^32 conversion, the stream is bit-identical across the browser,
 * the Node engine and the tensor engine - on a CPU today, and on an Instinct
 * device the same arithmetic is what executes. No framework RNG is ever used,
 * and the golden fixtures exist so this is checked rather than asserted.
 */

const M0 = 0xd2511f53;
const M1 = 0xcd9e8d57;
const BUMP0 = 0x9e3779b9;
const BUMP1 = 0xbb67ae85;

/** 32x32 -> 64 unsigned multiply, returned as [hi, lo] 32-bit halves. */
export function mul32x32(k: number, x: number): [number, number] {
  const xlo = x & 0xffff;
  const xhi = x >>> 16;
  const tl = k * xlo; // < 2^48, exact in double
  const th = k * xhi; // < 2^48, exact in double
  const tlHi = Math.floor(tl / 65536);
  const tlLo = tl % 65536;
  const mid = tlHi + th; // < 2^48, exact
  const hi = Math.floor(mid / 65536) >>> 0;
  const lo = (((mid % 65536) * 65536 + tlLo) >>> 0);
  return [hi, lo];
}

/** One Philox round over a 4-lane counter. */
function round(ctr: number[], key: number[]): number[] {
  const [hi0, lo0] = mul32x32(M0, ctr[0]);
  const [hi1, lo1] = mul32x32(M1, ctr[2]);
  return [
    (hi0 ^ ctr[1] ^ key[0]) >>> 0,
    (lo0 ^ ctr[3]) >>> 0,
    (hi1 ^ ctr[0] ^ key[1]) >>> 0,
    (lo1 ^ ctr[1]) >>> 0,
  ];
}

/**
 * 10-round Philox producing four u32 words for a (key, counter) pair.
 * counter is [c0, c1, c2, c3], key is [k0, k1].
 */
export function philox10(ctr: number[], key: number[]): number[] {
  let c = ctr.slice();
  let k = key.slice();
  for (let i = 0; i < 10; i++) {
    c = round(c, k);
    k = [(k[0] + BUMP0) >>> 0, (k[1] + BUMP1) >>> 0];
  }
  return c;
}

/** Split an arbitrary string/number seed into a 64-bit Philox key. */
export function seedToKey(seed: string | number): [number, number] {
  const s = typeof seed === 'number' ? `n${seed >>> 0}` : seed;
  let h1 = 0x9e3779b9 >>> 0;
  let h2 = 0xbb67ae85 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x85ebca6b) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h2 = Math.imul(h2 ^ (ch + i), 0xc2b2ae35) >>> 0;
    h2 = ((h2 << 17) | (h2 >>> 15)) >>> 0;
  }
  h1 = (h1 ^ h2) >>> 0;
  h2 = (h2 ^ (h1 + 0x9e3779b9)) >>> 0;
  return [h1 >>> 0, h2 >>> 0];
}

/**
 * Draw lane `lane` (0..3) for scenario `scn` at stream position `pos`.
 * Counter packing keeps every (scenario, position, lane) in its own cell,
 * so draws never depend on iteration order.
 */
export function drawU32(key: [number, number], scn: number, pos: number, lane = 0): number {
  const c0 = scn >>> 0;
  const c1 = Math.floor(scn / 4294967296) >>> 0;
  const c2 = pos >>> 0;
  const c3 = lane >>> 0;
  const out = philox10([c0, c1, c2, c3], key);
  return out[lane & 3] >>> 0;
}

export function drawFrac(key: [number, number], scn: number, pos: number, lane = 0): number {
  return drawU32(key, scn, pos, lane) / 4294967296;
}

/** Sequential scalar stream helper for one scenario. */
export class DrawStream {
  private pos = 0;
  private lane = 0;
  constructor(private key: [number, number], private scn: number) {}

  uniform(): number {
    const lane = this.lane & 3;
    this.lane++;
    if (this.lane % 4 === 0) this.pos++;
    return drawFrac(this.key, this.scn, this.pos, lane);
  }

  /** integer in [0, n) */
  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.uniform() * n));
  }

  /** pick an index from weights */
  weighted(weights: number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.uniform() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  normal(mean = 0, sd = 1): number {
    const u1 = Math.max(1e-12, this.uniform());
    const u2 = this.uniform();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  bernoulli(p: number): boolean {
    return this.uniform() < p;
  }
}
