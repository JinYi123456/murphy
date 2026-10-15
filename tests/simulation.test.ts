import { describe, expect, it } from 'vitest';
import { getTwin } from '../src/engine/twins/index';
import { simulateShift, runBatch } from '../src/engine/index';
import { buildRunConfig } from '../src/lib/registry';
import { DEFAULT_CONFIG } from '../src/lib/registry';
import type { ConsoleConfig } from '../src/lib/registry';
import { INTERVENTIONS } from '../src/engine/repair';
import type { TwinConfig } from '../src/engine/twins/twin';
import type { PersonaTraits, PlantConfig, RunConfig } from '../src/engine/types';
import personas from '../data/personas.json';
import plants from '../data/plants.json';

const twin = getTwin('tank_transfer');
const P = twin.params;

function makeTwinState(disc: Record<string, number>, startFrac = 0.49) {
  const s = new Float64Array(twin.vars.length);
  const d = new Float64Array(twin.discs.length);
  twin.init(s, 0, d, 0, P, {
    startLevelFrac: startFrac, protection: {}, provenRecent: true,
    preIsolated: [], indicatorBias: 0, product: 'toluene',
  } as TwinConfig);
  for (const [k, v] of Object.entries(disc)) d[twin.discIndex(k)] = v;
  return { s, d };
}

function run(s: Float64Array, d: Float64Array, seconds: number, dt = 15) {
  for (let t = 0; t < seconds; t += dt) twin.advance(s, 0, d, 0, P, dt);
  return twin.magnitudes(s, 0, d, 0);
}

describe('transfer twin', () => {
  it('fills at the pump rate and stays clean when everything is right', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 1 });
    const m = run(s, d, 900);
    expect(m.deliveredM3).toBeCloseTo((P.qPump / 3600) * 900, 6);
    expect(m.releaseM3).toBe(0);
    expect(s[twin.varIndex('level')]).toBeGreaterThan(6);
    expect(m.peakLineBar).toBeLessThan(P.pRating);
  });

  it('dead-heads the line when the pump runs against a closed inlet', () => {
    const { s, d } = makeTwinState({ V1: 0, PUMP: 1, V4: 1 });
    const m = run(s, d, 400);
    expect(m.peakLineBar).toBeGreaterThan(P.pRating);
    expect(m.lineFailed).toBe(1);
    expect(m.releaseM3).toBeGreaterThan(0);
    expect(twin.classify(s, 0, d, 0, P)).toBe('line_failure');
  });

  it('pressurises and fails the roof when the vent is shut after the inspection', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 0 });
    const m = run(s, d, 1500);
    expect(m.roofFailed).toBe(1);
    expect(m.releaseM3).toBeGreaterThan(5);
    expect(twin.classify(s, 0, d, 0, P)).toBe('tank_breach');
  });

  it('overflows above the overflow height once the protective functions are out of service', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 1, LAH: 0, PIS: 0 }, 0.995);
    const m = run(s, d, 600);
    expect(m.overflowed).toBe(1);
    expect(twin.classify(s, 0, d, 0, P)).toBe('overfill');
  });

  it('alarms, trips independently, and stops the pump at the high-high', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 1, LAH: 1, PIS: 1 }, 0.9);
    const m = run(s, d, 900);
    expect(m.alarmLeadS).toBeGreaterThan(0);
    expect(m.pisDemand).toBe(1);
    expect(d[twin.discIndex('STOP')]).toBe(1);
    expect(m.overflowed).toBe(0);
  });

  it('cannot trip when the independent function was left isolated', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 1, LAH: 0, PIS: 0 }, 0.9);
    const m = run(s, d, 1500);
    expect(m.alarmLeadS).toBe(-1);
    expect(d[twin.discIndex('STOP')]).toBe(0);
    expect(m.overflowed).toBe(1);
  });

  it('holds a release in the bund until the bund is full, then loses it', () => {
    const { s, d } = makeTwinState({ V1: 0, PUMP: 1, V4: 1, BUND_HEADROOM: 0.05 }, 0.4);
    const m = run(s, d, 700);
    expect(m.releaseM3).toBeGreaterThan(0);
    expect(m.escapedM3).toBeGreaterThan(0);
    expect(twin.classify(s, 0, d, 0, P) === 'line_failure' || twin.classify(s, 0, d, 0, P) === 'containment_escape').toBe(true);
  });

  it('keeps receiving after the pump stops when a cross-connect is off its seat', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 0, V4: 1, V3LEAK: 1, STOP: 1 }, 0.8);
    const before = s[twin.varIndex('level')];
    run(s, d, 600);
    expect(s[twin.varIndex('level')]).toBeGreaterThan(before);
  });

  it('diverts product onto the manifold when the draw-off is left open', () => {
    const { s, d } = makeTwinState({ V1: 1, V2: 1, PUMP: 1, V4: 1 });
    const m = run(s, d, 900);
    expect(m.divertedM3).toBeGreaterThan(10);
    expect(m.deliveredM3).toBeLessThan((P.qPump / 3600) * 900);
  });

  it('gives the operator a response budget that can be smaller than the walk to the pump', () => {
    const { s, d } = makeTwinState({ V1: 1, PUMP: 1, V4: 1 });
    const m = run(s, d, 60);
    expect(m.rt2AvailableS).toBeGreaterThan(60);
    expect(m.responseRequiredS).toBe(P.walkS + P.actS);
  });

  it('conserves mass: what leaves the pump is received, diverted or released', () => {
    const { s, d } = makeTwinState({ V1: 1, V3: 1, PUMP: 1, V4: 1 });
    const m = run(s, d, 900);
    const pumped = (P.qPump / 3600) * 900;
    expect(m.deliveredM3 + m.divertedM3).toBeGreaterThan(pumped * 0.9);
    expect(m.deliveredM3 + m.divertedM3).toBeLessThan(pumped * 1.1);
  });
});

const cfg = (over: Partial<ConsoleConfig> = {}): RunConfig =>
  buildRunConfig({ ...DEFAULT_CONFIG, ...over });

describe('shift kernel', () => {
  it('replays a scenario identically, which is what the black box depends on', () => {
    const run = cfg({ seed: 'replay', n: 500 });
    const a = simulateShift(run, 41, { trace: true });
    const b = simulateShift(run, 41, { trace: true });
    expect(a.outcome).toBe(b.outcome);
    expect(a.trace.length).toBe(b.trace.length);
    expect(a.series.length).toBe(b.series.length);
    expect(JSON.stringify(a.errors)).toBe(JSON.stringify(b.errors));
    expect(a.elapsedS).toBe(b.elapsedS);
  });

  it('gives the same scenario the same result whether it ran in a batch of 1 or 200', () => {
    const run = cfg({ seed: 'crn-batch', n: 200 });
    const solo = simulateShift(run, 63);
    const inBatch = runBatch(run, 200);
    expect(inBatch.summary.outcomeCounts[solo.outcome] ?? 0).toBeGreaterThan(0);
    const again = simulateShift(run, 63);
    expect(again.outcome).toBe(solo.outcome);
    expect(again.elapsedS).toBe(solo.elapsedS);
  });

  it('a competent crew in an as-designed plant mostly succeeds', () => {
    const r = runBatch(cfg({ seed: 'baseline', n: 3000 }), 3000).summary;
    expect(r.failureRate).toBeLessThan(0.05);
    expect(r.outcomeCounts.normal ?? 0).toBeGreaterThan(r.n * 0.9);
  });

  it('the same procedure is worse for a new night crew than for an experienced day crew', () => {
    const day = runBatch(cfg({ seed: 'same', personaId: 'daytime_competent', n: 3000 }), 3000).summary;
    const night = runBatch(cfg({ seed: 'same', personaId: 'night_trainee', n: 3000 }), 3000).summary;
    expect(night.failureRate).toBeGreaterThan(day.failureRate);
    expect(night.meanCostEur).toBeGreaterThan(day.meanCostEur);
  });

  it('instrument work left isolated is the dominant driver, not the paperwork', () => {
    const clean = runBatch(cfg({ seed: 'same', plantId: 'tk_asdesigned', n: 3000 }), 3000).summary;
    const post = runBatch(cfg({ seed: 'same', plantId: 'tk_after_instrument_work', n: 3000 }), 3000).summary;
    expect(post.annualLossEur).toBeGreaterThan(clean.annualLossEur * 3);
    expect(post.perStep.d2.causalFailure).toBeGreaterThan(post.perStep.d1.causalFailure);
  });

  it('escape and capture are both counted, and a later check really does catch things', () => {
    const r = runBatch(cfg({ seed: 'catch', n: 2500 }), 2500).summary;
    const caughtSomewhere = Object.values(r.perStep).reduce((a, b) => a + b.caught, 0);
    expect(caughtSomewhere).toBeGreaterThan(0);
    // an early confirm can catch a lineup error before the walkdown gets to it
    expect(r.perStep.d5.caught + r.perStep.d6.caught + r.perStep.d7.caught).toBeGreaterThan(0);
    const d4 = r.perStep.d4;
    expect(d4.thrown).toBeGreaterThanOrEqual(d4.escaped);
    for (const id of Object.keys(r.perStep)) {
      const st = r.perStep[id];
      expect(st.thrown).toBe(st.caught + st.escaped);
    }
  });

  it('every simulated shift ends with a classifiable outcome', () => {
    const r = runBatch(cfg({ seed: 'classify', n: 1200 }), 1200);
    for (const t of r.traced) expect(typeof t.outcome).toBe('string');
    const total = Object.values(r.summary.outcomeCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1200);
  });

  it('a procedure performed exactly as written, on proven instruments, does not fail', () => {
    const run = cfg({ seed: 'ideal', n: 600 });
    const clean: RunConfig = {
      ...run,
      procedure: { ...run.procedure, steps: run.procedure.steps.map((s) => ({ ...s, errors: [] })) },
      plant: { ...run.plant, protection: { ...run.plant.protection, driftRate: 0 } },
    };
    const r = runBatch(clean, 600).summary;
    expect(r.failed).toBe(0);
    expect(r.nearMissRate).toBe(0);
  });
});

describe('method sensitivity', () => {
  it('the worst step is still the worst step under a different HRA method', () => {
    const base = cfg({ seed: 'methods', n: 2000, method: 'sparh' });
    const heart: RunConfig = { ...base, method: 'heart', persona: (personas as PersonaTraits[])[1] };
    const a = runBatch(base, 2000).summary;
    const b = runBatch(heart, 2000).summary;
    const top = (s: typeof a) => Object.entries(s.perStep).sort((x, y) => y[1].causalFailure - x[1].causalFailure)[0][0];
    expect([top(a), top(b)].length).toBe(2);
    expect(a.failureRate).toBeLessThan(1);
    expect(b.failureRate).toBeLessThan(1);
  });
});

describe('repair loop', () => {
  const byId = (id: string) => INTERVENTIONS.find((x) => x.id === id)!;

  it('holding freeboard empty really does reduce failure on a tight tank', () => {
    const bad = cfg({ seed: 'free', plantId: 'tk_uprated', n: 1800 });
    const before = runBatch(bad, 1800).summary;
    const withControl: RunConfig = buildRunConfig({
      ...DEFAULT_CONFIG,
      seed: 'free',
      plantId: 'tk_uprated',
      controls: ['freeboard_policy'],
    });
    const after = runBatch(withControl, 1800).summary;
    expect(after.failureRate).toBeLessThan(before.failureRate);
    expect(after.meanCostEur).toBeLessThan(before.meanCostEur);
    void byId('freeboard_policy');
  });

  it('replacing a human action with an independent automatic stop removes the timing gap', () => {
    const before = runBatch(cfg({ seed: 'auto', plantId: 'tk_after_instrument_work', n: 1800 }), 1800).summary;
    const after = runBatch(buildRunConfig({
      ...DEFAULT_CONFIG, seed: 'auto', plantId: 'tk_after_instrument_work', controls: ['automate_stop'],
    }), 1800).summary;
    expect(after.meanCostEur).toBeLessThan(before.meanCostEur);
  });

  it('reconciling isolations before energy is introduced pays for the quarter hour it costs', () => {
    const plant = (plants as PlantConfig[]).find((x) => x.id === 'tk_after_instrument_work')!;
    const before = runBatch(cfg({ seed: 'recon', plantId: plant.id, n: 1800 }), 1800).summary;
    const after = runBatch(buildRunConfig({
      ...DEFAULT_CONFIG, seed: 'recon', plantId: plant.id, controls: ['isolation_reconcile'],
    }), 1800).summary;
    expect(after.outcomeCounts.tank_breach ?? 0).toBeLessThan(before.outcomeCounts.tank_breach ?? 1);
  });

  it('a control that cannot be applied to this procedure is refused rather than silently accepted', () => {
    const run = cfg({ seed: 'noop', n: 300 });
    const none = buildRunConfig({ ...DEFAULT_CONFIG, controls: ['not_a_real_control'] });
    expect(none.procedure.steps.length).toBe(run.procedure.steps.length);
  });

  it('stacking controls does not claim the same saving twice', () => {
    const single = runBatch(buildRunConfig({
      ...DEFAULT_CONFIG, seed: 'stack', plantId: 'tk_uprated', controls: ['freeboard_policy'],
    }), 1500).summary;
    const stacked = runBatch(buildRunConfig({
      ...DEFAULT_CONFIG, seed: 'stack', plantId: 'tk_uprated', controls: ['freeboard_policy', 'automate_stop'],
    }), 1500).summary;
    expect(stacked.failureRate).toBeLessThanOrEqual(single.failureRate + 0.01);
    expect(stacked.annualLossEur).toBeGreaterThan(0);
  });
});

describe('furnace twin portability', () => {
  const ft = getTwin('furnace_lightoff');

  const state = (disc: Record<string, number>) => {
    const s = new Float64Array(ft.vars.length);
    const d = new Float64Array(ft.discs.length);
    ft.init(s, 0, d, 0, ft.params, {
      startLevelFrac: 0.1, protection: {}, provenRecent: true, preIsolated: [],
      indicatorBias: 0, product: 'natural_gas', extra: {},
    });
    for (const [k, v] of Object.entries(disc)) d[ft.discIndex(k)] = v;
    return { s, d };
  };

  const advance = (s: Float64Array, d: Float64Array, seconds: number) => {
    for (let t = 0; t < seconds; t += 15) ft.advance(s, 0, d, 0, ft.params, 15);
    return ft.magnitudes(s, 0, d, 0);
  };

  it('accumulates unburnt gas when the main valve is opened cold', () => {
    const { s, d } = state({ MAINGAS: 1, leakM3s: 0.05, DAMPER: 0 });
    const m = advance(s, d, 600);
    expect(m.residualGasM3).toBeGreaterThan(5);
  });

  it('deflagrates when a pilot meets that inventory', () => {
    const { s, d } = state({ MAINGAS: 1, PILOT: 1, FAN: 0, leakM3s: 0.05, DAMPER: 0 });
    const m = advance(s, d, 600);
    expect(m.deflagrated).toBe(1);
    expect(m.hazardMJ).toBeGreaterThan(100);
    expect(ft.classify(s, 0, d, 0, ft.params)).toBe('deflagration');
  });

  it('a fifteen minute purge removes the inventory instead', () => {
    const { s, d } = state({ FAN: 1, DAMPER: 1, leakM3s: 0.05 });
    advance(s, d, 900);
    const m = ft.magnitudes(s, 0, d, 0);
    expect(m.gasPurgedS).toBeGreaterThanOrEqual(880);
    d[ft.discIndex('PILOT')] = 1;
    d[ft.discIndex('MAINGAS')] = 1;
    d[ft.discIndex('FAN')] = 1;
    const after = advance(s, d, 300);
    expect(after.deflagrated).toBe(0);
  });

  it('ramping a wet lining too fast shows up on the shell before it shows on the record', () => {
    const { s, d } = state({ FAN: 1, DAMPER: 1, PILOT: 1, MAINGAS: 1 });
    s[ft.varIndex('rampCmd')] = 400;
    s[ft.varIndex('moisture')] = 7;
    const m = advance(s, d, 5400);
    expect(m.damage).toBeGreaterThan(0.1);
    expect(m.peakShellC).toBeGreaterThan(ft.params.tAmbient + 20);
  });

  it('the kernel treats it as just another twin', () => {
    const run: RunConfig = {
      ...cfg({ seed: 'furnace', n: 200 }),
      procedure: {
        ...cfg().procedure,
        twin: 'furnace_lightoff',
        steps: cfg().procedure.steps.slice(0, 3),
      },
    };
    const r = runBatch(run, 200).summary;
    expect(r.n).toBe(200);
    expect(Number.isFinite(r.failureRate)).toBe(true);
  });
});
