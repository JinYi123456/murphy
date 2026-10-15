import { assess } from './assess';
import type { ConditionId } from './conditions';
import { computeHep, detectionProbability, PROTECTION_FOD } from './hra';
import type { ActionKind, HraMethod } from './hra';
import { drawFrac, seedToKey } from './prng';
import { getTwin } from './twins/index';
import type { TwinConfig, TwinDef } from './twins/twin';
import type {
  Cond, ErrorAlternative, OutcomeClass, PersonaTraits, PlantConfig, Patch,
  RunConfig, ShiftResult, Step, TraceEvent, WatchSpec,
} from './types';

/** The physics is advanced in chunks of at most this many seconds. */
const MAX_TICK_S = 15;
const MAX_TICKS = 600;
/** Stream positions 0..15 belong to shift-level sampling; steps start at 16. */
const SETUP_SLOTS = 16;

/**
 * Stable stream slot per step id.
 *
 * This is what turns a before/after comparison into a paired test. A step
 * keeps the same random numbers across procedure revisions, so inserting or
 * deleting a step does not reshuffle every other step's draws. Without it the
 * comparison would be unpaired and a real effect would be buried in noise.
 */
export function slotFor(stepId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < stepId.length; i++) {
    h ^= stepId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 4096) * 8 + SETUP_SLOTS;
}

export interface ScenarioSetup {
  permitLeftSomethingIsolated: boolean;
  instrumentDrift: number;
  driveDegraded: number;
  protectionFailedOnDemand: boolean;
}

export function sampleSetup(cfg: RunConfig, key: [number, number], scn: number): ScenarioSetup {
  const plant = cfg.plant;
  const drift = num(plant.protection, 'driftRate', 0.18);
  const iso = (plant.preIsolated?.length ?? 0) > 0 ? 1 : 0.3;
  const fod = plant.provenRecent ? PROTECTION_FOD.independent_switch : PROTECTION_FOD.independent_switch * 4;
  const u0 = drawFrac(key, scn, 1, 0);
  const u1 = drawFrac(key, scn, 2, 1);
  const u2 = drawFrac(key, scn, 3, 2);
  const u3 = drawFrac(key, scn, 4, 3);
  const u4 = drawFrac(key, scn, 5, 0);
  const standing = Math.abs(cfg.plant.instrumentDrift?.level ?? 0);
  return {
    permitLeftSomethingIsolated: u0 < iso * 0.35,
    instrumentDrift: u1 < drift ? (u2 - 0.5) * 2 * (0.3 + standing) : 0,
    driveDegraded: u3 < 0.1 ? 0.72 + u4 * 0.25 : 1,
    protectionFailedOnDemand: flag(plant.protection, 'independent') && u4 < fod,
  };
}

function flag(rec: Record<string, boolean | number>, k: string): boolean {
  return rec[k] !== false && rec[k] !== 0;
}

function num(rec: Record<string, boolean | number>, k: string, dflt: number): number {
  const v = rec[k];
  return typeof v === 'number' ? v : dflt;
}

/**
 * Error producing conditions active for one performance of one step.
 * Partly the analyst's annotation, partly the persona, partly emergent from
 * the shift so far: schedule slip and an alarm ringing mid-action are not
 * declared in the procedure, they are earned.
 */
export function conditionsFor(
  step: Step,
  persona: PersonaTraits,
  plant: PlantConfig,
  ctx: { slipRatio: number; alarmRinging: boolean; hazardSeen: boolean; setup: ScenarioSetup },
  warnings: { cond: ConditionId; level: number; steps: string[] }[] = [],
): Partial<Record<ConditionId, number>> {
  const out: Partial<Record<ConditionId, number>> = {};
  const add = (c: ConditionId, level: number) => {
    out[c] = Math.max(out[c] ?? 0, level);
  };

  for (const c of step.cond ?? []) add(c, 1);
  // cue quality is scored once, in the ergonomics row of the worksheet, and is
  // deliberately not also injected as a condition: that would count it twice
  if (step.cue === 'verbal') add('teamwork', 1);
  if (step.cue === 'light' && plant.protection['alarmFrequentFalse'] === true) add('mistrust', 1);

  if (persona.experienceY < 1.5 || !persona.qualificationCurrent) add('low_experience', 2);
  else if (persona.experienceY < 4 || persona.runsBefore < 3) add('low_experience', 1);
  if (persona.hoursIntoShift > 10 || persona.shiftStartHour < 5) add('fatigue', 2);
  else if (persona.hoursIntoShift > 8 || persona.shiftStartHour < 7) add('fatigue', 1);
  if (persona.languageFriction > 0.4) add('language_barrier', 2);
  if (persona.concurrency >= 2) add('distraction', 2);
  else if (persona.concurrency >= 1) add('distraction', 1);
  if (persona.teamReadiness < 0.5) add('teamwork', 2);
  else if (persona.teamReadiness < 0.8) add('teamwork', 1);
  if (persona.deadlinePressure > 0.6) add('time_pressure', 1);

  if (ctx.slipRatio > 1.4) add('time_pressure', 3);
  else if (ctx.slipRatio > 1.2) add('time_pressure', 2);
  else if (ctx.slipRatio > 1.05) add('time_pressure', 1);

  if (ctx.alarmRinging) add('situation_awareness', 2);
  if (ctx.hazardSeen) add('unprepared_exception', 2);

  if (ctx.setup.permitLeftSomethingIsolated || (plant.preIsolated?.length ?? 0) > 0) add('post_maintenance_state', 2);
  if (!plant.provenRecent) add('incomplete_function_test', 1);
  if (Math.abs(ctx.setup.instrumentDrift) > 0.15) add('mistrust', 1);
  if (plant.protection['alarmFrequentFalse'] === true) add('mistrust', 1);

  for (const w of warnings) if (w.steps.includes(step.id)) add(w.cond, w.level);
  return out;
}

export function condHolds(c: Cond, value: number): boolean {
  switch (c.op) {
    case 'lt': return value < c.value;
    case 'lte': return value <= c.value;
    case 'gt': return value > c.value;
    case 'gte': return value >= c.value;
    case 'eq': return value === c.value;
  }
}

export interface StepAudit {
  stepId: string;
  p: number;
  lo: number;
  hi: number;
  nominal: number;
  multiplier: number;
  kind: ActionKind;
  basis: string;
  adjusted: boolean;
  rows: { id: string; label: string; level: string; mult: number; why: string }[];
  suppressed: { psf: string; level: string; why: string }[];
  conditions: ConditionId[];
}

export interface ExtendedResult extends ShiftResult {
  /** process history for the black box replay */
  series: { tS: number; v: Record<string, number>; d: Record<string, number> }[];
  audit: StepAudit[];
  scheduleSlip: number;
  hazardSeconds: number;
  note: string;
  twin: string;
  method: HraMethod;
}

export interface SimOptions {
  trace?: boolean;
  sampleEveryS?: number;
  /** run the step under a different method than the configuration asks for */
  method?: HraMethod;
}

/**
 * Run one shift. Deterministic in (cfg, scn): the same scenario number replays
 * identically inside any batch size, which is what lets the replay view
 * reproduce exactly the failure a user clicked on.
 */
export function simulateShift(cfg: RunConfig, scn: number, opts: SimOptions = {}): ExtendedResult {
  const twin = getTwin(cfg.procedure.twin);
  const p = twin.params;
  const iface = twin.iface;
  const method = opts.method ?? cfg.method;
  const s = new Float64Array(twin.vars.length);
  const d = new Float64Array(twin.discs.length);
  const steps = cfg.procedure.steps;

  const key = seedToKey(cfg.seed);
  const setup = sampleSetup(cfg, key, scn);

  const twinCfg: TwinConfig = {
    startLevelFrac: cfg.plant.freeboardPct ?? 0.49,
    protection: cfg.plant.protection as Record<string, boolean>,
    provenRecent: cfg.plant.provenRecent,
    preIsolated: cfg.plant.preIsolated ?? [],
    indicatorBias: (cfg.plant.instrumentDrift?.level ?? 0) + setup.instrumentDrift,
    product: cfg.plant.product ?? 'default',
    extra: cfg.plant.protection as Record<string, number>,
  };
  twin.init(s, 0, d, 0, p, twinCfg);
  const putDisc = (name: string, value: number) => {
    const i = twin.discIndex(name);
    if (i >= 0) d[i] = value;
  };
  putDisc(iface.scale ?? '', setup.driveDegraded);
  putDisc(iface.failOnDemand ?? '', setup.protectionFailedOnDemand ? 1 : 0);

  const trace: TraceEvent[] = [];
  const series: ExtendedResult['series'] = [];
  const audit: StepAudit[] = [];
  const errors: ShiftResult['errors'] = [];
  const caught: Record<string, string> = {};
  const log = (e: TraceEvent) => {
    if (opts.trace) trace.push(e);
  };

  const T = (name: string) => {
    const i = twin.varIndex(name);
    return i >= 0 ? s[i] : 0;
  };
  const read = (name: string) => (name.startsWith('indicated:')
    ? twin.indication(s, 0, d, 0, name.slice(10))
    : T(name));
  /** A step effect may name a scenario flag or a process variable; both are assignments. */
  const applyPatch = (patch?: Patch) => {
    if (!patch) return;
    for (const [k, v] of Object.entries(patch)) {
      const di = twin.discIndex(k);
      if (di >= 0) { d[di] = v; continue; }
      const vi = twin.varIndex(k);
      if (vi >= 0) s[vi] = v;
    }
  };
  const setVars = (rec?: Record<string, number>) => applyPatch(rec);

  let elapsed = 0;
  let planned = 0;
  let hazardSeconds = 0;
  const target = p[iface.target];
  const tick = iface.tickS ?? MAX_TICK_S;
  const runout = iface.runoutFactor ?? 1.6;
  // the run-out is sized by the physics, not by a magic constant: enough ticks
  // to reach the completion target plus sixty per cent, whatever the asset
  const closingTicks = Math.min(3000, Math.max(60, Math.ceil((target * runout) / Math.max(1e-9, p[iface.rate] * tick))));

  log({
    tS: 0, kind: 'clock', label: 'Shift start',
    detail: `${cfg.persona.label} - ${cfg.plant.label}`,
    vars: { start: T(iface.progress), indicated: read(`indicated:${iface.progress}`) },
  });

  const pushSeries = () => {
    const v: Record<string, number> = {};
    for (const n of twin.vars) v[n] = s[twin.varIndex(n)];
    const dd: Record<string, number> = {};
    for (const n of twin.discs) dd[n] = d[twin.discIndex(n)];
    series.push({ tS: elapsed, v, d: dd });
  };

  const integrateFor = (durS: number, tickCap = MAX_TICKS) => {
    const n = Math.max(1, Math.min(tickCap, Math.ceil(durS / tick)));
    const dt = durS / n;
    const every = opts.trace ? Math.max(1, Math.round((opts.sampleEveryS ?? 10) / dt)) : 0;
    for (let i = 0; i < n; i++) {
      const beforeAlarm = T(iface.alarm);
      const beforeHazard = T(iface.hazard);
      twin.advance(s, 0, d, 0, p, dt);
      elapsed += dt;
      if (beforeAlarm === 0 && T(iface.alarm) === 1) {
        log({
          tS: elapsed, kind: 'alarm', label: 'First annunciator of the shift',
          detail: `indicator reads ${read(`indicated:${iface.progress}`).toFixed(1)}, actual ${T(iface.progress).toFixed(1)}`,
          vars: { actual: T(iface.progress), indicated: read(`indicated:${iface.progress}`) },
        });
      }
      if (beforeHazard === 0 && T(iface.hazard) > 0) {
        log({ tS: elapsed, kind: 'hazard', label: 'Something has actually gone wrong', detail: twin.hazardNote(s, 0, d, 0, p), vars: { hazard: T(iface.hazard) } });
      }
      if (T(iface.hazard) > 0) hazardSeconds += dt;
      if (opts.trace && i % every === 0) pushSeries();
    }
  };

  for (const step of steps) {
    const tStart = elapsed;
    const slipRatio = planned > 0 ? elapsed / planned : 1;
    if (step.guard && !condHolds(step.guard, read(step.guard.var))) {
      log({ tS: elapsed, kind: 'step', stepId: step.id, label: step.title, detail: 'Not required in this configuration', vars: { skipped: 1 } });
      continue;
    }

    const conds = conditionsFor(step, cfg.persona, cfg.plant, {
      slipRatio,
      alarmRinging: T(iface.alarm) === 1 && d[twin.discIndex(iface.stopFlag)] === 0,
      hazardSeen: T(iface.hazard) > 0,
      setup,
    }, (cfg.procedure.warnings ?? []).map((w) => ({ cond: w.cond, level: w.level, steps: w.steps })));

    const assessment = assess({
      step, persona: cfg.persona, plant: cfg.plant,
      alarmRinging: T(iface.alarm) === 1 && d[twin.discIndex(iface.stopFlag)] === 0,
    }, conds);
    const hep = computeHep({
      method,
      kind: step.kind,
      similarity: step.similarity,
      insideProcedure: step.applies !== undefined || step.verify !== undefined,
      psfs: assessment.rows,
      gtt: step.gtt,
    });
    const slot = slotFor(step.id);

    log({
      tS: elapsed, kind: 'step', stepId: step.id, label: step.title, detail: step.text,
      vars: { p: hep.p, mult: hep.multiplier, actual: T(iface.progress), indicated: read(`indicated:${iface.progress}`) },
    });

    const surface = step.errors ?? [];
    let thrown: ErrorAlternative | null = null;
    if (surface.length) {
      const uErr = drawFrac(key, scn, slot, 0);
      if (uErr < hep.p) {
        let total = 0;
        for (const e of surface) total += e.weight;
        let r = drawFrac(key, scn, slot, 1) * total;
        let pick = surface.length - 1;
        for (let i = 0; i < surface.length; i++) {
          r -= surface[i].weight;
          if (r <= 0) { pick = i; break; }
        }
        thrown = surface[pick];
      }
    }

    if (thrown) {
      errors.push({ stepId: step.id, errorId: thrown.id, kind: thrown.kind, atS: elapsed, p: hep.p });
      log({ tS: elapsed, kind: 'error', stepId: step.id, label: thrown.kind, detail: thrown.text, vars: { p: hep.p } });
      applyPatch(thrown.patch);
      if (thrown.alsoApplies) setVars(step.applies);
    } else {
      setVars(step.applies);
    }

    audit.push({
      stepId: step.id, p: hep.p, lo: hep.lo, hi: hep.hi, nominal: hep.nominal, multiplier: hep.multiplier,
      kind: step.kind, basis: hep.basis, adjusted: hep.adjusted,
      rows: hep.rows.map((r, i) => ({ ...r, why: assessment.rows[i]?.why ?? '' })),
      suppressed: assessment.suppressed.map((s) => ({ psf: s.psf, level: s.why, why: s.why })),
      conditions: Object.keys(conds) as ConditionId[],
    });

    if (step.verify) {
      const open = errors.filter((e) => step.verify!.of.includes(e.stepId) && !caught[`${e.stepId}/${e.errorId}`]);
      if (open.length) {
        const vConds = conditionsFor(step, cfg.persona, cfg.plant, { slipRatio, alarmRinging: false, hazardSeen: T(iface.hazard) > 0, setup });
        const pdet = detectionProbability({
          method, kind: step.verify.kind ?? 'verify', similarity: step.similarity,
          insideProcedure: true,
          psfs: assess({ step, persona: cfg.persona, plant: cfg.plant, alarmRinging: false }, vConds).rows,
          gtt: step.verify.gtt,
        });
        const u = drawFrac(key, scn, slot, 2);
        if (u < pdet) {
          for (const e of open) {
            caught[`${e.stepId}/${e.errorId}`] = step.id;
            const src = steps.find((x) => x.id === e.stepId);
            const orig = src?.errors?.find((x) => x.id === e.errorId);
            if (orig?.patch) {
              for (const kn of Object.keys(orig.patch)) {
                if (!src?.applies || src.applies[kn] === undefined) {
                  const di = twin.discIndex(kn);
                  if (di >= 0) d[di] = 0;
                }
              }
            }
            setVars(src?.applies);
            log({
              tS: elapsed, kind: 'recovery', stepId: step.id, label: 'Deviation caught',
              detail: `${step.title} caught ${orig?.text ?? e.errorId}`, vars: { pdet },
            });
          }
        } else {
          log({
            tS: elapsed, kind: 'verify', stepId: step.id, label: 'Check passed with nothing found',
            detail: `${step.title} did not detect the earlier deviation`, vars: { pdet },
          });
        }
      }
    }

    if (step.watch) {
      runWatch(step, step.watch, thrown, slot, key, scn, twin, s, d, cfg, setup, {
        read, T, setVars, integrateFor, log, elapsed: () => elapsed,
      });
    } else {
      const dur = step.durS * (0.75 + 0.5 * drawFrac(key, scn, slot, 4));
      integrateFor(dur);
      if (step.until) {
        const lim = T(step.until.var);
        if (lim < step.until.atLeast) {
          const rate = Math.max(1e-9, p[iface.rate] * (d[twin.discIndex(iface.scale ?? '')] || 1));
          integrateFor(Math.min(3600, (step.until.atLeast - lim) / rate));
        }
      }
    }

    if (step.deadline && !condHolds(step.deadline, read(step.deadline.var))) {
      log({
        tS: elapsed, kind: 'hazard', stepId: step.id, label: 'Performed too late to matter',
        detail: `${step.title} was done after ${step.deadline.var} reached ${step.deadline.value}`,
      });
    }

    // Schedule drift is the overrun, not the duration: a monitoring step that
    // takes the time it was given has not made the crew late. Without this
    // distinction a ten hour furnace cure stamps every following step as
    // operating under extreme time pressure, which is a modelling error and not
    // a finding.
    const allowance = step.durS + (step.watch?.scheduledS ?? step.watch?.maxWaitS ?? 0);
    planned += Math.max(step.durS, Math.min(allowance, elapsed - tStart));

    if (T(iface.hazard) > 0 && hazardSeconds > 240) break;
  }

  // whatever is still running keeps running until it is finished or shut down
  let emergencyRolled = false;
  let guard = 0;
  while (d[twin.discIndex(iface.runFlag)] === 1 && d[twin.discIndex(iface.stopFlag)] === 0
    && guard++ < closingTicks && T(iface.progress) < target * runout) {
    const em = steps.find((x) => x.emergency !== undefined);
    if (em && T(iface.hazard) > 0 && !emergencyRolled) {
      emergencyRolled = true;
      const spec = em.emergency!;
      const conds = conditionsFor(em, cfg.persona, cfg.plant, { slipRatio: 1, alarmRinging: true, hazardSeen: true, setup });
      conds.unprepared_exception = Math.max(conds.unprepared_exception ?? 0, 2);
      conds.situation_awareness = Math.max(conds.situation_awareness ?? 0, 2);
      const hepE = computeHep({
        method, kind: em.kind, insideProcedure: true,
        psfs: assess({ step: em, persona: cfg.persona, plant: cfg.plant, alarmRinging: true }, conds).rows,
      });
      const u = drawFrac(key, scn, slotFor(em.id), 5);
      const lateS = spec.maxResponseS * drawFrac(key, scn, slotFor(em.id), 6);
      if (u >= hepE.p) {
        integrateFor(lateS, 40);
        setVars(spec.onHit);
        log({
          tS: elapsed, kind: 'recovery', stepId: em.id, label: 'Emergency action taken',
          detail: `${em.title} - ${lateS.toFixed(0)} s after the release was noticed`,
          vars: { pMiss: hepE.p, lateS },
        });
      } else {
        log({
          tS: elapsed, kind: 'error', stepId: em.id, label: 'Emergency action not taken',
          detail: `The release was not recognised or not actioned: ${em.title}`, vars: { pMiss: hepE.p },
        });
      }
    }
    integrateFor(tick, 1);
  }

  const mag = twin.magnitudes(s, 0, d, 0);
  const cls = twin.classify(s, 0, d, 0, p);
  const note = twin.hazardNote(s, 0, d, 0, p);
  log({ tS: elapsed, kind: 'outcome', label: cls, detail: note, vars: mag });
  if (opts.trace) pushSeries();

  const causal = errors.filter((e) => !caught[`${e.stepId}/${e.errorId}`]);
  const failedCls = cls !== 'normal' && cls !== 'intercepted';
  return {
    scn,
    outcome: cls as OutcomeClass,
    failed: cls !== 'normal' && cls !== 'intercepted',
    errors: causal,
    caughtBy: caught,
    peak: mag,
    costEur: 0,
    downtimeMin: 0,
    releaseM3: mag.releaseM3 ?? 0,
    nearMiss: !failedCls && T(iface.alarm) === 1,
    elapsedS: elapsed,
    trace,
    series,
    audit,
    scheduleSlip: planned > 0 ? elapsed / planned : 1,
    hazardSeconds,
    note,
    twin: twin.id,
    method,
  };
}

/**
 * A watch step: the operator monitors a value and is expected to act when they
 * see it. The failure mode is not "did they do it" but "when", so a deviation
 * shows up as a shift in the trigger point rather than a discrete state.
 */
function runWatch(
  step: Step,
  w: WatchSpec,
  thrown: ErrorAlternative | null,
  slot: number,
  key: [number, number],
  scn: number,
  twin: TwinDef,
  s: Float64Array,
  d: Float64Array,
  cfg: RunConfig,
  setup: ScenarioSetup,
  ctx: {
    read: (n: string) => number;
    T: (n: string) => number;
    setVars: (rec?: Record<string, number>) => void;
    integrateFor: (seconds: number, cap?: number) => void;
    log: (e: TraceEvent) => void;
    elapsed: () => number;
  },
): void {
  const iface = twin.iface;
  const late = thrown !== null && (thrown.kind === 'delayed_response' || thrown.kind === 'misread' || thrown.kind === 'omission');
  /**
   * Lateness is modelled as time, not as a shifted threshold: an operator who
   * misses the cue acts some seconds after it, and how many is drawn from the
   * step's stable slot so that editing an unrelated step cannot reshuffle it.
   * Time is the honest unit here, because it is the unit the overfill guidance
   * measures response budgets in.
   */
  const lateS = late ? (0.15 + 0.85 * drawFrac(key, scn, slot, 3)) * (w.lateMaxS ?? 240) : 0;
  const maxWait = w.maxWaitS ?? 1500;
  const t0 = ctx.elapsed();
  let armedAt = -1;
  let acted = false;
  while (ctx.elapsed() - t0 < maxWait) {
    const v = ctx.read(w.var);
    const met = (w.atLeast !== undefined && v >= w.atLeast)
      || (w.atMost !== undefined && v <= w.atMost)
      || (w.alt !== undefined && ctx.T(w.alt.var) >= w.alt.atLeast);
    if (met && armedAt < 0) armedAt = ctx.elapsed();
    if (armedAt >= 0 && ctx.elapsed() - armedAt >= lateS) {
      ctx.setVars(w.onHit);
      ctx.log({
        tS: ctx.elapsed(), kind: 'recovery', label: late ? 'Operator acted late' : 'Operator acted',
        detail: `${step.title} - cue at ${v.toFixed(1)}, acted ${(ctx.elapsed() - armedAt).toFixed(0)} s after it`,
        vars: { value: v, reactionS: ctx.elapsed() - armedAt },
      });
      acted = true;
      break;
    }
    ctx.integrateFor(twin.iface.tickS ?? MAX_TICK_S, 1);
    if (d[twin.discIndex(iface.stopFlag)] === 1) { acted = true; break; }
    if (ctx.T(iface.hazard) > 0 && ctx.elapsed() - t0 > 400) break;
  }
  if (!acted) {
    ctx.log({
      tS: ctx.elapsed(), kind: 'clock', label: 'Watch window closed',
      detail: `${step.title} never reached its criterion inside ${maxWait} s`,
    });
  }
  void setup;
}
