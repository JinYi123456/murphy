/** Data model for a written procedure, the process twin it operates on, and the record of a simulated shift. */
import type { ConditionId } from './conditions';
import type { ActionKind, HraMethod } from './hra';

export type Cue =
  | 'label'
  | 'gauge'
  | 'light'
  | 'checklist'
  | 'memory'
  | 'physical'
  | 'verbal'
  | 'document';

export type ErrorKind =
  | 'omission'
  | 'commission'
  | 'wrong_target'
  | 'wrong_direction'
  | 'out_of_sequence'
  | 'incomplete'
  | 'premature'
  | 'delayed_response'
  | 'misread';

/** A comparison against a twin variable, used for guards and watch criteria. */
export interface Cond {
  var: string;
  op: 'lt' | 'lte' | 'gt' | 'gte' | 'eq';
  value: number;
}

/** Plant variables an error forces, by name. Names are checked against the twin. */
export type Patch = Record<string, number>;

export interface ErrorAlternative {
  id: string;
  kind: ErrorKind;
  /** relative weight within this step's error surface */
  weight: number;
  /** situational narrative: how a real person gets this wrong in this plant */
  text: string;
  /** executable consequence on the plant model */
  patch: Patch;
  /** does the operator still perform the intended action as well? default false */
  alsoApplies?: boolean;
  /** what the operator would notice, if anything */
  symptom?: string;
  /** provenance of this alternative */
  source: 'analyst' | 'model' | 'model+review';
}

export interface VerifySpec {
  /** ids of the steps being checked */
  of: string[];
  /** how the check establishes the truth */
  via: Cue;
  /** action type of the checking action itself */
  kind?: ActionKind;
  gtt?: string;
}

export interface WatchSpec {
  /** twin variable to watch; "indicated:" prefix applies the instrument error */
  var: string;
  atLeast?: number;
  atMost?: number;
  /**
   * A second criterion that ends the watch. A real field operator stops on
   * whichever of "level reached 9.30 m" or "meter reached 55 m3" comes first,
   * and modelling only one of them invents a hazard that is not there.
   */
  alt?: { var: string; atLeast: number };
  /** what the operator does when they see it */
  onHit?: Record<string, number>;
  /** what the crew was scheduled to spend on the watch, for schedule drift */
  scheduledS?: number;
  /** give up watching after this many seconds */
  maxWaitS?: number;
  /** how late an operator who misses the cue can be, seconds; drawn per scenario */
  lateMaxS?: number;
}

export interface Step {
  id: string;
  title: string;
  /** verbatim procedure language, as the operator would read it */
  text: string;
  role: string;
  cue: Cue;
  /** what the human is being asked to do; selects the nominal rate in every method */
  kind: ActionKind;
  /** HEART generic task type, optional override of the default for the kind */
  gtt?: string;
  /** number of near-identical devices a choice has to be made between */
  similarity?: number;
  /** error producing conditions the analyst judged applicable */
  cond?: ConditionId[];
  /** nominal execution time in seconds */
  durS: number;
  /** intended change to the plant configuration */
  applies?: Record<string, number>;
  /** the typed set of ways this step can go wrong */
  errors?: ErrorAlternative[];
  /** this step checks an earlier one */
  verify?: VerifySpec;
  /** this step monitors the process until a criterion is seen */
  watch?: WatchSpec;
  /** this step is expected to drive the process to at least this value */
  until?: { var: string; atLeast: number };
  /** only performed when this holds */
  guard?: Cond;
  /** a control that must be established before the process reaches this point */
  deadline?: Cond;
  /** a control has required an independent verification of this step */
  xcheck?: boolean;
  /** what the crew does if the process has already gone wrong: armed for the whole shift */
  emergency?: { maxResponseS: number; onHit: Record<string, number> };
}

export interface ProcedureWarning {
  id: string;
  label: string;
  /** condition this warning implies */
  cond: ConditionId;
  level: number;
  steps: string[];
}

export interface Procedure {
  id: string;
  title: string;
  twin: string;
  revision: string;
  language: string;
  roles: string[];
  summary: string;
  warnings?: ProcedureWarning[];
  steps: Step[];
}

export interface PersonaTraits {
  id: string;
  label: string;
  experienceY: number;
  shiftStartHour: number;
  hoursIntoShift: number;
  /** 0 = procedure is in the operator's first language */
  languageFriction: number;
  /** concurrent job load, 0 = sole task */
  concurrency: number;
  /** prior exposure to this exact procedure, count */
  runsBefore: number;
  /** production pressure applied by supervision, 0..1 */
  deadlinePressure: number;
  qualificationCurrent: boolean;
  teamReadiness: number;
  notes: string;
}

export interface PlantConfig {
  id: string;
  /** which twin this configuration applies to */
  twin?: string;
  label: string;
  /** protective functions in place; keys documented per twin */
  protection: Record<string, boolean | number>;
  /** protective device proven within the test interval */
  provenRecent: boolean;
  /** instruments that a permit has left isolated at the start of the shift */
  preIsolated?: string[];
  /** standing additive error on the local indicator, metres */
  instrumentDrift?: Record<string, number>;
  product?: string;
  /** start level as a fraction of the overflow height */
  freeboardPct?: number;
  notes?: string;
}

export interface RunConfig {
  procedure: Procedure;
  persona: PersonaTraits;
  plant: PlantConfig;
  method: HraMethod;
  seed: string;
  /** wall-clock shift length the schedule allows, seconds */
  shiftBudgetS?: number;
}

export type OutcomeClass =
  | 'normal'
  | 'intercepted'
  | 'minor_release'
  | 'overfill'
  | 'containment_escape'
  | 'line_failure'
  | 'tank_breach'
  | 'misrouting'
  | 'no_flow'
  | 'short_batch'
  | 'trip_stop'
  | 'deflagration'
  | 'refractory_damage'
  | 'shell_hotspot'
  | 'no_light_off'
  | 'scrap_batch'
  | 'cold_slab_scrap'
  | 'overheat_scrap'
  | 'refractory_overtemp'
  | 'flame_out'
  | 'production_hold'
  | 'hot_start';

/**
 * A shift that ended in an aborted batch is not a shift that ended in a release,
 * and a plant reports them on different sheets to different people. Blending the
 * two into one failure percentage is how a tool like this gets dismissed by the
 * operations manager, because it would call a routine goodnight an incident.
 */
export const SEVERITY: Record<string, 'normal' | 'upset' | 'incident'> = {
  normal: 'normal',
  intercepted: 'normal',
  no_flow: 'upset',
  short_batch: 'upset',
  trip_stop: 'upset',
  no_light_off: 'upset',
  minor_release: 'incident',
  overfill: 'incident',
  containment_escape: 'incident',
  line_failure: 'incident',
  tank_breach: 'incident',
  misrouting: 'incident',
  deflagration: 'incident',
  refractory_damage: 'incident',
  shell_hotspot: 'incident',
  hot_start: 'incident',
  scrap_batch: 'upset',
  /**
   * An operating reheat furnace reports to two different sheets. Metal that is
   * too cold to roll is a production upset the mill absorbs; metal that is
   * over-heated has left the rolling window in the direction that cannot be
   * recovered by re-heating it, and it usually means the refractory saw the same
   * temperature the slab did. That is damage, not a schedule problem.
   */
  cold_slab_scrap: 'upset',
  overheat_scrap: 'incident',
  production_hold: 'upset',
  flame_out: 'incident',
  refractory_overtemp: 'incident',
};

export function severityOf(outcome: string): 'normal' | 'upset' | 'incident' {
  return SEVERITY[outcome] ?? 'incident';
}

export interface TraceEvent {
  /** seconds from shift start */
  tS: number;
  kind: 'step' | 'error' | 'verify' | 'alarm' | 'hazard' | 'recovery' | 'outcome' | 'clock';
  stepId?: string;
  label: string;
  detail?: string;
  vars?: Record<string, number | string>;
}

export interface ShiftResult {
  scn: number;
  outcome: OutcomeClass;
  failed: boolean;
  /** error steps that were never caught, in order of occurrence */
  errors: { stepId: string; errorId: string; kind: ErrorKind; atS: number; p: number }[];
  /** error key -> id of the step that caught it */
  caughtBy: Record<string, string>;
  peak: Record<string, number>;
  costEur: number;
  downtimeMin: number;
  releaseM3: number;
  nearMiss: boolean;
  elapsedS: number;
  trace: TraceEvent[];
}
