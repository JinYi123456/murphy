import type { ConditionId } from './conditions';
import type { ActionKind } from './hra';
import type { PersonaTraits, PlantConfig, Procedure, Step } from './types';

/**
 * Intervention catalogue.
 *
 * A candidate fix is a typed mutation of the model, not a paragraph of advice.
 * That is what lets the loop be honest: the change is applied to the procedure
 * or the configuration, the same scenarios are re-run against it, and the
 * paired difference decides. Each entry names the tier it belongs to in the
 * hierarchy of controls, because a fix that removes the need for the human
 * action is worth more than one that asks the human to be more careful, and
 * the model has to be able to say so.
 */

export type ControlTier = 'substitution' | 'engineering' | 'administrative' | 'training' | 'organisational';

export interface InterventionEffect {
  /** conditions the intervention removes or weakens, as a multiplier on severity */
  conditions?: Partial<Record<ConditionId, number>>;
  /** replace a label-and-handle action with a keyed or interlocked one: the device cannot be wrong */
  forcedControl?: boolean;
  /** insert an independent verification of the targeted step, performed by a second person */
  insertVerification?: boolean;
  /** rewrite the step so it produces a checkable artefact */
  rewriteClarity?: boolean;
  /** require the pre-job walkdown to confirm instrument status */
  walkdown?: boolean;
  /** plant configuration patch, e.g. bring the proof test inside its interval */
  plant?: Partial<PlantConfig>;
  /** freeboard policy: start level fraction of the danger threshold */
  startLevelFrac?: number;
  /** extra seconds per shift this costs the crew */
  addedSeconds?: number;
  /** annualised cost of the control, EUR */
  annualCostEur?: number;
}

export interface Intervention {
  id: string;
  label: string;
  tier: ControlTier;
  /** one sentence a plant manager would recognise */
  describe: string;
  /** which step characteristics this intervention can act on */
  selector: StepSelector;
  effect: InterventionEffect;
  /** how the model represents the mechanism, for the audit trail */
  mechanism: string;
}

export interface StepSelector {
  /** only target steps carrying one of these conditions */
  conditions?: ConditionId[];
  cues?: Step['cue'][];
  kinds?: ActionKind[];
  /** cap on how many steps one intervention may touch */
  maxSteps?: number;
}

/**
 * The catalogue is ordered weak-to-strong on purpose: the loop evaluates every
 * candidate that the target steps admit, and the paired test - not this order
 * - decides what ships.
 */
export const INTERVENTIONS: Intervention[] = [
  {
    id: 'rewrite_clarity',
    label: 'Rewrite the step into one unambiguous action with a checkable artefact',
    tier: 'administrative',
    describe: 'The step currently allows more than one reading. Rewrite it so the operator can prove, in the document, that it was done.',
    selector: { conditions: ['ambiguous_wording', 'poor_procedure', 'memory_load'], maxSteps: 4 },
    effect: {
      rewriteClarity: true,
      conditions: { ambiguous_wording: 0, poor_procedure: 0, memory_load: 0.25 },
      annualCostEur: 1800,
      addedSeconds: 10,
    },
    mechanism: 'Removes the poor-procedure and ambiguity shaping factors; the residual error rate is the action itself, not the reading of it.',
  },
  {
    id: 'physical_tag',
    label: 'Attach a photographic line-up tag to the device',
    tier: 'administrative',
    describe: 'A tag at the valve showing the valve number and the correct position for this transfer.',
    selector: { conditions: ['confusable_device', 'absent_cue'], cues: ['label', 'physical'], maxSteps: 6 },
    effect: {
      conditions: { confusable_device: 0.2, absent_cue: 0 },
      annualCostEur: 900,
      addedSeconds: 25,
    },
    mechanism: 'Replaces recall and inference from an adjacent identical device with a directly readable cue.',
  },
  {
    id: 'independent_verification',
    label: 'Independent second-person verification of the line-up',
    tier: 'administrative',
    describe: 'A second competent person confirms the configuration and signs it, before energy is introduced.',
    selector: { conditions: ['confusable_device', 'post_maintenance_state', 'low_experience'], kinds: ['actuate'], maxSteps: 3 },
    effect: {
      insertVerification: true,
      conditions: { situation_awareness: 0.5, post_maintenance_state: 0.35 },
      annualCostEur: 14000,
      addedSeconds: 240,
    },
    mechanism: 'Adds a detection action with its own human error probability; the deviation has to survive two independent failures, not one.',
  },
  {
    id: 'readback',
    label: 'Read-back on the instruction',
    tier: 'organisational',
    describe: 'The person receiving the instruction repeats it back before acting. Standard practice in aviation, rail and medicine.',
    selector: { conditions: ['teamwork', 'language_barrier'], cues: ['verbal'], maxSteps: 4 },
    effect: {
      conditions: { teamwork: 0.25, language_barrier: 0.4 },
      annualCostEur: 2200,
      addedSeconds: 45,
    },
    mechanism: 'Turns a one-way transmission into a checkable exchange, cutting the teamwork and interpretation shaping factors.',
  },
  {
    id: 'forced_control',
    label: 'Key the device so only the correct one can be moved',
    tier: 'engineering',
    describe: 'A mechanical key interlock or a coded valve that physically cannot be operated in the wrong sequence.',
    selector: { conditions: ['confusable_device', 'timing_critical'], kinds: ['actuate'], maxSteps: 4 },
    effect: {
      forcedControl: true,
      conditions: { confusable_device: 0 },
      annualCostEur: 26000,
      addedSeconds: 15,
    },
    mechanism: 'Removes the wrong-target error mode entirely rather than making it less likely; the residual risk is the interlock failing on demand.',
  },
  {
    id: 'automate_stop',
    label: 'Independent automatic stop, no human action required',
    tier: 'engineering',
    describe: 'A hard-wired high-high switch that stops the pump on its own, on a measurement that is independent of the control system.',
    selector: { conditions: ['timing_critical', 'fatigue', 'mistrust'], kinds: ['monitor', 'actuate'], maxSteps: 2 },
    effect: {
      plant: { protection: { independent: true, pis: true } },
      startLevelFrac: undefined,
      annualCostEur: 19000,
      addedSeconds: 0,
    },
    mechanism: 'Substitutes a machine action for a human one. The remaining failure probability is the device failing on demand, which is two orders of magnitude lower than a person acting late.',
  },
  {
    id: 'freeboard_policy',
    label: 'Cap the starting level: hold the critical zone empty',
    tier: 'engineering',
    describe: 'A dispatch rule that will not release a transfer unless enough freeboard exists for the whole batch plus the pump-down volume.',
    selector: { kinds: ['monitor', 'authorise'], maxSteps: 1 },
    effect: {
      startLevelFrac: 0.4,
      annualCostEur: 6500,
      addedSeconds: 0,
    },
    mechanism: 'Buys physical time. Every downstream human failure gets a longer window in which a later step can still catch it.',
  },
  {
    id: 'proven_instrument',
    label: 'Bring the protective instrument inside its proof-test interval',
    tier: 'engineering',
    describe: 'The high-high switch is stroke-tested to the documented interval, and the certificate is checked at permit issue.',
    selector: { conditions: ['incomplete_function_test', 'mistrust'], maxSteps: 2 },
    effect: {
      plant: { provenRecent: true },
      conditions: { incomplete_function_test: 0 },
      annualCostEur: 5200,
      addedSeconds: 30,
    },
    mechanism: 'Restores the fail-on-demand rate of the independent function to its design value.',
  },
  {
    id: 'isolation_reconcile',
    label: 'Pre-job walkdown that reconciles isolations against permits',
    tier: 'administrative',
    describe: 'Before energy is introduced, somebody confirms on the plant that every instrument the permits touched is back in service.',
    selector: { conditions: ['post_maintenance_state'], kinds: ['verify', 'authorise'], maxSteps: 2 },
    effect: {
      walkdown: true,
      plant: { preIsolated: [] },
      conditions: { post_maintenance_state: 0.15 },
      annualCostEur: 9000,
      addedSeconds: 420,
    },
    mechanism: 'Removes the surprise: the shift starts with the configuration the procedure assumes. Costs a quarter of an hour, which is exactly the argument you will have with the shift supervisor.',
  },
  {
    id: 'schedule_buffer',
    label: 'Remove the deadline from the task',
    tier: 'organisational',
    describe: 'The transfer is not scheduled against a truck turnaround target, so falling behind is not a reason to skip a check.',
    selector: { conditions: ['time_pressure'], maxSteps: 8 },
    effect: {
      conditions: { time_pressure: 0.15 },
      annualCostEur: 12000,
      addedSeconds: 0,
    },
    mechanism: 'Attacks the shaping factor that multiplies every other error: a rushed crew is not a careful crew.',
  },
  {
    id: 'qualification_gate',
    label: 'Gate the task on documented repetition',
    tier: 'training',
    describe: 'Nobody performs the transfer alone before a defined number of supervised executions.',
    selector: { conditions: ['low_experience', 'novel_task'], maxSteps: 6 },
    effect: {
      conditions: { low_experience: 0.2, novel_task: 0 },
      annualCostEur: 8000,
      addedSeconds: 0,
    },
    mechanism: 'Moves the action up the familiarity axis of the reliability table instead of asking the person to try harder.',
  },
  {
    id: 'working_language',
    label: 'Issue the procedure in the crew working language',
    tier: 'administrative',
    describe: 'The controlled copy exists in the language the field operator actually reads under time pressure.',
    selector: { conditions: ['language_barrier'], maxSteps: 8 },
    effect: {
      conditions: { language_barrier: 0 },
      annualCostEur: 4300,
      addedSeconds: 0,
    },
    mechanism: 'Removes the translation load from safety-critical instructions.',
  },
];

export interface DraftProcedure {
  procedure: Procedure;
  plant: PlantConfig;
  persona: PersonaTraits;
  /** extra seconds added to the shift by the controls */
  addedSeconds: number;
  /** annualised cost of the controls */
  annualCostEur: number;
  applied: string[];
}

const byId = new Map(INTERVENTIONS.map((i) => [i.id, i]));

export function interventionById(id: string): Intervention | undefined {
  return byId.get(id);
}

/** Steps an intervention could act on, in procedure order. */
export function targetSteps(int: Intervention, procedure: Procedure): Step[] {
  const out: Step[] = [];
  const sel = int.selector;
  for (const s of procedure.steps) {
    if (sel.conditions && sel.conditions.length) {
      if (!s.cond?.some((c) => sel.conditions!.includes(c))) continue;
    }
    if (sel.cues && !sel.cues.includes(s.cue)) continue;
    if (sel.kinds) {
      const kind = s.kind;
      if (!sel.kinds.includes(kind)) continue;
    }
    out.push(s);
  }
  return sel.maxSteps ? out.slice(0, sel.maxSteps) : out;
}

export function kindOf(s: Step): 'actuate' | 'verify' | 'communicate' | 'authorise' | 'monitor' {
  if (s.verify) return 'verify';
  if (s.watch) return 'monitor';
  if (s.cue === 'verbal') return 'communicate';
  if (s.applies && Object.keys(s.applies).length) return 'actuate';
  return 'authorise';
}

/**
 * Apply an intervention to a copy of the configuration.
 * Returns null when the intervention has nothing to act on.
 */
export function applyIntervention(base: DraftProcedure, int: Intervention): DraftProcedure | null {
  const targets = targetSteps(int, base.procedure);
  if (targets.length === 0 && !int.effect.plant && int.effect.startLevelFrac === undefined) return null;

  const procedure: Procedure = {
    ...base.procedure,
    revision: `${base.procedure.revision}+${int.id}`,
    steps: base.procedure.steps.map((s) => applyToStep(s, int, targets.some((t) => t.id === s.id))),
  };

  const plant: PlantConfig = { ...base.plant, ...(int.effect.plant ?? {}), protection: { ...base.plant.protection, ...(int.effect.plant?.protection ?? {}) } };
  if (int.effect.startLevelFrac !== undefined) plant.freeboardPct = int.effect.startLevelFrac;
  if (int.effect.walkdown) plant.preIsolated = [];

  const persona: PersonaTraits = int.effect.insertVerification
    ? { ...base.persona, concurrency: base.persona.concurrency, teamReadiness: Math.min(1, base.persona.teamReadiness + 0.35) }
    : base.persona;

  return {
    procedure,
    plant,
    persona,
    addedSeconds: base.addedSeconds + (int.effect.addedSeconds ?? 0) * Math.max(1, targets.length),
    annualCostEur: base.annualCostEur + (int.effect.annualCostEur ?? 0),
    applied: [...base.applied, int.id],
  };
}

function applyToStep(s: Step, int: Intervention, targeted: boolean): Step {
  const eff = int.effect;
  let next: Step = { ...s, cond: s.cond ? [...s.cond] : [] };

  if (targeted && eff.conditions) {
    for (const [c, scale] of Object.entries(eff.conditions) as [ConditionId, number][]) {
      if (scale <= 0.4) next.cond = (next.cond ?? []).filter((x) => x !== c);
    }
  }

  if (targeted && eff.forcedControl) {
    // the device cannot be wrong: strip the wrong-target and wrong-direction modes
    next.errors = (next.errors ?? []).filter((e) => e.kind !== 'wrong_target' && e.kind !== 'wrong_direction');
    next.cue = 'physical';
    next.cond = (next.cond ?? []).filter((c) => c !== 'confusable_device');
    next.applies = { ...(next.applies ?? {}), INTERLOCKED: 1 };
  }

  if (targeted && eff.insertVerification) next.xcheck = true;

  if (targeted && eff.rewriteClarity) {

    next.text = `${s.text} Record the reading and the time on the transfer permit.`;
    next.cue = 'checklist';
    next.cond = (next.cond ?? []).filter((c) => c !== 'ambiguous_wording' && c !== 'poor_procedure' && c !== 'memory_load');
  }

  return next;
}

/**
 * The verification step inserted by an independent check. It is deliberately
 * modelled as its own human action: a second person signing a form is only as
 * good as the second person.
 */
export function verificationStep(target: Step): Step {
  return {
    id: `${target.id}__xcheck`,
    title: `Independent check: ${target.title}`,
    text: `Second competent person confirms by direct observation that "${target.title}" is correctly established, and initials the permit.`,
    role: 'verifier',
    cue: 'checklist',
    kind: 'verify',
    cond: ['confusable_device'],
    durS: 90,
    verify: { of: [target.id], via: 'checklist', kind: 'verify' },
  };
}

/** Splice the inserted verifications into the procedure right after their target. */
export function materialiseVerifications(procedure: Procedure): Procedure {
  const steps: Step[] = [];
  for (const s of procedure.steps) {
    steps.push(s);
    if (s.xcheck) {
      steps.push(verificationStep(s));
    }
  }
  return { ...procedure, steps };
}
