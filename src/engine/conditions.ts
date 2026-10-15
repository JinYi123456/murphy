/**
 * Condition catalogue and PSF bindings.
 *
 * Steps are annotated with method-neutral site conditions ("these valves are
 * confusable", "the plant is not in the state the procedure assumes"). Each
 * condition names which performance shaping factor it informs and at which
 * published level, for severity 1 (present), 2 (marked) and 3 (severe).
 *
 * The rows are published in NUREG/CR-6883. The assignment of a site condition
 * to a row, and the severity, is an analyst judgement - the UI shows both so a
 * process-safety engineer can overrule them rather than argue with a number.
 */
import { SPAR_PSFs } from './hra';
import type { PsfState } from './hra';

export type ConditionId =
  | 'novel_task'
  | 'low_experience'
  | 'confusable_device'
  | 'ambiguous_wording'
  | 'memory_load'
  | 'poor_procedure'
  | 'timing_critical'
  | 'time_pressure'
  | 'distraction'
  | 'interruption'
  | 'fatigue'
  | 'teamwork'
  | 'mistrust'
  | 'unprepared_exception'
  | 'situation_awareness'
  | 'post_maintenance_state'
  | 'language_barrier'
  | 'incomplete_function_test'
  | 'absent_cue';

/** SPAR-H level indices for severity 1 / 2 / 3. Kept deliberately mild at 1. */
interface Binding {
  psf: PsfState['psf'];
  at: [number, number, number];
  why: string;
}

const BINDINGS: Record<ConditionId, Binding[]> = {
  novel_task: [
    { psf: 'CX', at: [3, 2, 1], why: 'not one of the actions this crew performs regularly' },
    { psf: 'E-T', at: [2, 1, 0], why: 'no accumulated experience for this task' },
  ],
  low_experience: [
    { psf: 'E-T', at: [2, 1, 0], why: 'below the qualification depth this task needs' },
  ],
  confusable_device: [
    { psf: 'HCI', at: [2, 1, 1], why: 'near-identical devices side by side, no positive position indication' },
  ],
  ambiguous_wording: [
    { psf: 'PRU', at: [3, 2, 1], why: 'the wording admits more than one reading' },
  ],
  memory_load: [
    { psf: 'HCI', at: [2, 1, 0], why: 'the information needed is not present at the point of action' },
  ],
  poor_procedure: [
    { psf: 'PRU', at: [2, 2, 1], why: 'no checkable artefact, so the step cannot be proved to have been done' },
  ],
  timing_critical: [
    { psf: 'AVL', at: [2, 1, 1], why: 'the outcome depends on acting inside a short window' },
  ],
  time_pressure: [
    { psf: 'AVL', at: [2, 1, 1], why: 'the schedule has slipped against the procedure' },
    { psf: 'STR', at: [2, 1, 0], why: 'dispatch pressure is being applied while the step is in hand' },
  ],
  distraction: [
    { psf: 'STR', at: [2, 1, 0], why: 'a second task is competing for attention' },
  ],
  interruption: [
    { psf: 'STR', at: [2, 1, 1], why: 'the action is broken part way through' },
  ],
  fatigue: [
    { psf: 'FFD', at: [2, 1, 1], why: 'night rotation or long hours on shift' },
  ],
  teamwork: [
    { psf: 'WMP', at: [1, 0, 0], why: 'no read-back and unclear ownership of the step' },
  ],
  mistrust: [
    { psf: 'WMP', at: [1, 0, 0], why: 'alarm history has taught the crew to discount the indication' },
    { psf: 'STR', at: [2, 1, 1], why: 'the operator does not believe the instrument in front of him' },
  ],
  unprepared_exception: [
    { psf: 'CX', at: [3, 2, 1], why: 'the situation is not one the procedure or the training covers' },
  ],
  situation_awareness: [
    { psf: 'CX', at: [2, 2, 1], why: 'the working model of the plant can drift from the actual configuration' },
    { psf: 'STR', at: [2, 1, 1], why: 'an annunciator is active while another action is in hand' },
  ],
  post_maintenance_state: [
    { psf: 'WMP', at: [0, 0, 0], why: 'return to service is not reconciled before energy is introduced' },
    { psf: 'HCI', at: [2, 2, 1], why: 'nothing at the point of action shows the true isolation state' },
  ],
  language_barrier: [
    { psf: 'PRU', at: [2, 2, 1], why: 'the controlled copy is not in the operator working language' },
  ],
  incomplete_function_test: [
    { psf: 'WMP', at: [1, 0, 0], why: 'a protective device is in service without a current proof test' },
  ],
  absent_cue: [
    { psf: 'HCI', at: [2, 1, 1], why: 'no indication in the field where the decision is made' },
  ],
};

export const CONDITION_LABELS: Record<ConditionId, string> = {
  novel_task: 'unfamiliar to this crew',
  low_experience: 'below qualification depth',
  confusable_device: 'adjacent identical devices',
  ambiguous_wording: 'wording admits two readings',
  memory_load: 'relies on recall',
  poor_procedure: 'no checkable artefact',
  timing_critical: 'timing decides the outcome',
  time_pressure: 'behind the procedure',
  distraction: 'parallel job load',
  interruption: 'interrupted mid-action',
  fatigue: 'night rotation / long hours',
  teamwork: 'no read-back, unclear ownership',
  mistrust: 'crew discounts the indication',
  unprepared_exception: 'not covered by training',
  situation_awareness: 'model of the plant can drift',
  post_maintenance_state: 'plant not in the assumed state',
  language_barrier: 'not the working language',
  incomplete_function_test: 'device in service unproven',
  absent_cue: 'nothing to look at in the field',
};

export const ALL_CONDITIONS = Object.keys(BINDINGS) as ConditionId[];

/** Resolve a condition at a severity into its SPAR-H row. */
export function bind(cond: ConditionId, severity: number): { psf: PsfState['psf']; levelIndex: number; severity: number; why: string }[] {
  const sev = Math.min(3, Math.max(1, Math.round(severity)));
  return (BINDINGS[cond] ?? []).map((b) => ({
    psf: b.psf,
    levelIndex: b.at[sev - 1],
    severity: sev,
    why: `${CONDITION_LABELS[cond]} - ${b.why}`,
  }));
}

export function levelLabel(psf: PsfState['psf'], levelIndex: number): string {
  const def = SPAR_PSFs[psf];
  return def.levels[Math.min(def.levels.length - 1, Math.max(0, levelIndex))].name;
}

export function levelMult(psf: PsfState['psf'], levelIndex: number): number {
  const def = SPAR_PSFs[psf];
  return def.levels[Math.min(def.levels.length - 1, Math.max(0, levelIndex))].action;
}

export function isValidCondition(c: string): c is ConditionId {
  return (BINDINGS as Record<string, unknown>)[c] !== undefined;
}

/** The published SPAR-H shaping factors, for the reference sheet in the UI. */
export const PSF_REFERENCE = Object.entries(SPAR_PSFs).map(([id, def]) => ({
  id,
  label: def.label,
  levels: def.levels.map((l) => ({ name: l.name, mult: l.action, fails: l.fails === true })),
}));
