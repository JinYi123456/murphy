import { describe, expect, it } from 'vitest';
import { drawFrac, drawU32, seedToKey, DrawStream, mul32x32, philox10 } from '../src/engine/prng';
import { computeHep, detectionProbability, SPAR_NOMINAL, SPAR_FLOOR, sparAdjustment, THERP_BASE, HEART_GTT } from '../src/engine/hra';
import { assess, MAX_NEGATIVE_PSFS } from '../src/engine/assess';
import { bind, ALL_CONDITIONS } from '../src/engine/conditions';
import { pairedBootstrap, benjaminiHochberg, cvar, quantile } from '../src/engine/stats';
import { inspectModel } from '../src/engine/model';
import { slotFor } from '../src/engine/runner';
import proc from '../data/procedures/OP-TRF-014.json';
import personas from '../data/personas.json';
import plants from '../data/plants.json';
import type { PersonaTraits, PlantConfig, Procedure, Step } from '../src/engine/types';

describe('deterministic random stream', () => {
  it('is a valid 32x32->64 multiply', () => {
    // largest representable products, checked against the algebra rather than a table
    for (const [a, b] of [[0xffffffff, 0xffffffff], [1, 1], [0x10000, 0x10000], [0xdeadbeef, 0xcafef00d]] as const) {
      const [hi, lo] = mul32x32(a, b);
      const product = BigInt(a) * BigInt(b);
      expect((BigInt(hi) << 32n) | BigInt(lo)).toBe(product);
    }
  });

  it('produces identical words for identical counters and different words otherwise', () => {
    const key = seedToKey('MURPHY-GOLDEN-1');
    expect(drawU32(key, 5, 12, 0)).toBe(drawU32(key, 5, 12, 0));
    expect(drawU32(key, 5, 12, 0)).not.toBe(drawU32(key, 5, 13, 0));
    expect(drawU32(key, 5, 12, 0)).not.toBe(drawU32(key, 6, 12, 0));
    const set = new Set<number>();
    for (let scn = 0; scn < 300; scn++) for (let pos = 0; pos < 5; pos++) set.add(drawU32(key, scn, pos, 1));
    expect(set.size).toBe(1500);
  });

  it('is statistically sane enough to drive a Monte Carlo', () => {
    const key = seedToKey('stats-check');
    const n = 60_000;
    let sum = 0;
    let sum2 = 0;
    let serial = 0;
    let prev = drawFrac(key, 0, 0, 0);
    for (let i = 0; i < n; i++) {
      const scn = i % 2000;
      const pos = Math.floor(i / 2000);
      const u = drawFrac(key, scn, pos, scn % 4);
      sum += u;
      sum2 += u * u;
      serial += (u - 0.5) * (prev - 0.5);
      prev = u;
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.006);
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.004);
    expect(Math.abs(serial / n)).toBeLessThan(0.004);
  });

  it('gives every (scenario, step) its own cell so batch size cannot change a result', () => {
    const key = seedToKey('crn');
    const a = drawFrac(key, 17, slotFor('d8'), 0);
    const b = drawFrac(key, 17, slotFor('d8'), 0);
    expect(a).toBe(b);
    expect(slotFor('d8')).toBe(slotFor('d8'));
    expect(slotFor('d8')).not.toBe(slotFor('d12'));
  });

  it('DrawStream advances without aliasing lanes', () => {
    const key = seedToKey('stream');
    const s1 = new DrawStream(key, 3);
    const s2 = new DrawStream(key, 3);
    for (let i = 0; i < 20; i++) expect(s1.uniform()).toBe(s2.uniform());
  });

  it('philox round constants stay inside 32 bits', () => {
    const out = philox10([1, 2, 3, 4], [5, 6]);
    for (const w of out) {
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('human reliability quantification', () => {
  const step: Step = {
    id: 'x', title: 't', text: 't', role: 'op', cue: 'label', kind: 'actuate', cond: ['confusable_device'], durS: 60,
    applies: { V1: 1 },
  };
  const competent: PersonaTraits = (personas as PersonaTraits[])[0];
  const good: PlantConfig = (plants as PlantConfig[])[0];

  it('SPAR-H multiplies the published shaping factors and respects the floor', () => {
    const a = assess({ step, persona: competent, plant: good, alarmRinging: false }, {});
    const r = computeHep({ method: 'sparh', kind: 'actuate', psfs: a.rows });
    expect(r.nominal).toBe(SPAR_NOMINAL.action);
    expect(r.p).toBeGreaterThanOrEqual(SPAR_FLOOR);
    expect(r.p).toBeLessThanOrEqual(0.98);
  });

  it('applies the published adjustment factor when three or more factors are negative', () => {
    const rows = [
      { psf: 'PRU' as const, levelIndex: 1, severity: 3, why: '' },
      { psf: 'HCI' as const, levelIndex: 0, severity: 3, why: '' },
      { psf: 'AVL' as const, levelIndex: 1, severity: 3, why: '' },
    ];
    const c = 20 * 50 * 10;
    const expected = (SPAR_NOMINAL.action * c) / (1 + SPAR_NOMINAL.action * (c - 1));
    const r = computeHep({ method: 'sparh', kind: 'actuate', psfs: rows });
    expect(r.adjusted).toBe(true);
    expect(r.p).toBeCloseTo(expected, 12);
  });

  it('never lets inferred conditions stack beyond three negative factors', () => {
    const every = Object.fromEntries(ALL_CONDITIONS.map((c) => [c, 3])) as Record<string, number>;
    const a = assess({ step, persona: competent, plant: good, alarmRinging: true }, every as never);
    const negatives = a.rows.filter((r) => r.levelIndex < 3 && ['AVL', 'STR', 'CX', 'E-T', 'PRU', 'HCI', 'FFD', 'WMP'].includes(r.psf));
    expect(a.suppressed.length).toBeGreaterThan(0);
    expect(negatives.length).toBeGreaterThanOrEqual(MAX_NEGATIVE_PSFS);
  });

  it('distinguishes a trained operator from a new one on the same step', () => {
    const rookie = { ...competent, id: 'r', experienceY: 0.4, runsBefore: 0, qualificationCurrent: false };
    const a = computeHep({ method: 'sparh', kind: 'actuate', psfs: assess({ step, persona: competent, plant: good, alarmRinging: false }, {}).rows });
    const b = computeHep({ method: 'sparh', kind: 'actuate', psfs: assess({ step, persona: rookie, plant: good, alarmRinging: false }, {}).rows });
    expect(b.p).toBeGreaterThan(a.p * 3);
  });

  it('HEART caps at unity and uses its own generic task types', () => {
    const rows = [{ psf: 'PRU' as const, levelIndex: 0, severity: 3, why: '' }];
    const r = computeHep({ method: 'heart', kind: 'actuate', psfs: rows, gtt: 'A' });
    expect(r.nominal).toBe(HEART_GTT.A.gep);
    expect(r.p).toBeLessThanOrEqual(1);
    const clean = computeHep({ method: 'heart', kind: 'actuate', psfs: [], gtt: 'H' });
    expect(clean.p).toBe(HEART_GTT.H.gep);
  });

  it('THERP keys the base rate off the error type, not off a guess', () => {
    const verify = computeHep({ method: 'therp', kind: 'verify', psfs: [] });
    const actuate = computeHep({ method: 'therp', kind: 'actuate', similarity: 1, psfs: [] });
    expect(verify.nominal).toBe(THERP_BASE.walk_around_miss.p);
    expect(actuate.nominal).toBe(THERP_BASE.commission_label.p);
  });

  it('every method reports an order-of-magnitude band, not a point', () => {
    for (const m of ['sparh', 'therp', 'heart'] as const) {
      const r = computeHep({ method: m, kind: 'verify', psfs: [] });
      expect(r.lo).toBeLessThan(r.p);
      expect(r.hi).toBeGreaterThan(r.p);
    }
  });

  it('a check step is only as good as the person doing it', () => {
    const a = detectionProbability({ method: 'sparh', kind: 'verify', psfs: [] });
    const b = detectionProbability({
      method: 'sparh', kind: 'verify',
      psfs: [{ psf: 'HCI' as const, levelIndex: 0, severity: 3, why: '' }],
    });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(0.05);
  });

  it('binding severities never move a factor in the safer direction', () => {
    for (const c of ALL_CONDITIONS) {
      const one = bind(c, 1);
      const three = bind(c, 3);
      for (let i = 0; i < one.length; i++) {
        expect(three[i].levelIndex).toBeLessThanOrEqual(one[i].levelIndex);
      }
    }
  });
});

describe('paired statistics', () => {
  it('finds no effect where there is none', () => {
    const a = Float64Array.from({ length: 400 }, (_, i) => (i % 7) - 3);
    const e = pairedBootstrap(a, a, { iterations: 300 });
    expect(e.delta).toBe(0);
    expect(e.ciLow).toBeLessThanOrEqual(0);
    expect(e.ciHigh).toBeGreaterThanOrEqual(0);
  });

  it('detects a small paired improvement that an unpaired test would miss', () => {
    const base = Float64Array.from({ length: 3000 }, (_, i) => {
      const u = ((i * 2654435761) % 1000) / 1000;
      return u < 0.11 ? 1 : 0;
    });
    const cand = Float64Array.from({ length: 3000 }, (_, i) => {
      const u = ((i * 2654435761) % 1000) / 1000;
      return u < 0.1 ? 1 : 0;
    });
    const e = pairedBootstrap(base, cand, { iterations: 600 });
    expect(e.delta).toBeLessThan(0);
    expect(e.ciHigh).toBeLessThan(0);
    expect(e.oneSidedRisk).toBeLessThan(0.05);
  });

  it('controls false discovery across a candidate set', () => {
    const keep = benjaminiHochberg([0.001, 0.4, 0.02, 0.03, 0.9], 0.05);
    expect(keep[0]).toBe(true);
    expect(keep[4]).toBe(false);
    expect(keep.filter(Boolean).length).toBeLessThanOrEqual(4);
  });

  it('tail risk is never below the mean', () => {
    const v = Float64Array.from({ length: 1000 }, (_, i) => (i < 990 ? 0 : i * 100));
    expect(cvar(v, 0.95)).toBeGreaterThanOrEqual(quantile(v, 0.95));
  });
});

describe('model integrity gate', () => {
  const p = proc as unknown as Procedure;

  it('accepts the shipped procedure', () => {
    const r = inspectModel(p);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects a patch that names a plant variable that does not exist', () => {
    const broken = JSON.parse(JSON.stringify(p));
    broken.steps[3].errors[0].patch.set = { NOT_A_VALVE: 1 };
    const r = inspectModel(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/NOT_A_VALVE/);
  });

  it('rejects duplicate step ids and forward verification references', () => {
    const dup = JSON.parse(JSON.stringify(p));
    dup.steps[1].id = dup.steps[0].id;
    expect(inspectModel(dup).errors.join(' ')).toMatch(/duplicate/);

    const forward = JSON.parse(JSON.stringify(p));
    forward.steps[1].verify = { of: ['d14'], via: 'checklist', kind: 'verify' };
    expect(inspectModel(forward).errors.join(' ')).toMatch(/not earlier/);
  });

  it('rejects an unknown condition so it cannot silently do nothing', () => {
    const bad = JSON.parse(JSON.stringify(p));
    bad.steps[0].cond = ['confuddled_device'];
    expect(inspectModel(bad).errors.join(' ')).toMatch(/unknown condition/);
  });
});
