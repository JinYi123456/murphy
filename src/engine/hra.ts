/**
 * Human reliability analysis: three published quantification methods, one
 * interface.
 *
 * Why three and not one: every hackathon project that puts a number on human
 * error either invents it or quotes one table nobody checks. Here a finding is
 * only considered robust when the ranking of failure modes survives a change
 * of method, and the UI says so. The absolute level never claims to be better
 * than order-of-magnitude - that is what the source documents themselves say
 * (see docs/METHOD.md), and pretending otherwise is how a tool like this gets
 * ignored by the engineers who would have to trust it.
 *
 * Source basis, with the strength of each claim marked:
 *
 *  [PRIM] read in the primary document
 *   - NUREG/CR-1278 (THERP), Appendix G Table G-1: general error rates by
 *     error type, and the nominal first-estimate HEP of 0.003.
 *   - NUREG/CR-6883 (SPAR-H): nominal HEP 1.0E-03 action / 1.0E-02 diagnosis,
 *     floor 1.0E-05, eight PSFs with graded multipliers, multiplication rule,
 *     and the adjustment factor applied when three or more PSFs are negative.
 *   - HSE RR679 and the reprinted HEART table: generic task types with GEPs
 *     from 0.00002 to 0.55, HEP = GEP x product of EPC factors, cap at 1.0.
 *   - IAEA PUB2102 annex (NARA, the HEART successor): EPC maximum factors in
 *     the range 1.2 to 30.
 *  [ASSIGN] our mapping of a named site condition onto a row of those tables.
 *   The rows are published; the assignment of a condition to a level is an
 *   analyst judgement and is shown to the user as such.
 *
 * Not used deliberately: the widely reprinted "Ps = 0.9999 / 0.999 / 0.995"
 * THERP action-class ladder and PSF multipliers of x10/x20/x100. They are
 * quoted across the literature but do not appear in the primary documents,
 * so they are not load-bearing here.
 */

export type HraMethod = 'sparh' | 'therp' | 'heart';
export const HRA_METHODS: HraMethod[] = ['sparh', 'therp', 'heart'];

export type ActionKind = 'actuate' | 'verify' | 'communicate' | 'authorise' | 'monitor' | 'recover';

/* ------------------------------------------------------------------ SPAR-H */

export type SparPsfId = 'AVL' | 'STR' | 'CX' | 'E-T' | 'PRU' | 'HCI' | 'FFD' | 'WMP';

export interface SparLevel {
  /** SPAR-H level name */
  name: string;
  /** multiplier on the nominal human error probability, action column */
  action: number;
  /** multiplier for a diagnosis action, where the source gives a different value */
  diagnosis?: number;
  /** zero means the level cannot be met and the action is assumed to fail */
  fails?: boolean;
}

/**
 * NUREG/CR-6883 Table 5-1 family, values as published.
 */
export const SPAR_PSFs: Record<SparPsfId, { label: string; levels: SparLevel[] }> = {
  AVL: {
    label: 'Available time',
    levels: [
      { name: 'inadequate time', action: 1, fails: true },
      { name: 'less than time required', action: 10 },
      { name: 'time required or less than nominal', action: 1 },
      { name: '5 times the nominal time', action: 0.1 },
      { name: '50 times the nominal time', action: 0.01 },
    ],
  },
  STR: {
    label: 'Stress / stressors',
    levels: [
      { name: 'extreme', action: 5 },
      { name: 'high', action: 2 },
      { name: 'low to nominal', action: 1 },
      { name: 'low', action: 0.5 },
    ],
  },
  CX: {
    label: 'Complexity',
    levels: [
      { name: 'very complex', action: 10 },
      { name: 'high', action: 5 },
      { name: 'moderate', action: 2 },
      { name: 'easy', action: 1 },
      { name: 'obvious', action: 0.1 },
    ],
  },
  'E-T': {
    label: 'Experience and training',
    levels: [
      { name: 'low or none', action: 10, diagnosis: 10 },
      { name: 'below average', action: 5 },
      { name: 'average', action: 2 },
      { name: 'above average', action: 1 },
      { name: 'expert', action: 0.5 },
    ],
  },
  PRU: {
    label: 'Procedures',
    levels: [
      { name: 'not available', action: 50 },
      { name: 'incomplete', action: 20 },
      { name: 'poor', action: 5 },
      { name: 'unused where available', action: 1 },
      { name: 'good', action: 0.5 },
    ],
  },
  HCI: {
    label: 'Ergonomics / HMI',
    levels: [
      { name: 'missing or misleading', action: 50 },
      { name: 'poor', action: 10 },
      { name: 'adequate', action: 2 },
      { name: 'good', action: 1 },
      { name: 'excellent', action: 0.5 },
    ],
  },
  FFD: {
    label: 'Fitness for duty',
    levels: [
      { name: 'unfit', action: 1, fails: true },
      { name: 'degraded', action: 5 },
      { name: 'average', action: 1 },
      { name: 'excellent', action: 0.1 },
    ],
  },
  WMP: {
    label: 'Work processes',
    levels: [
      { name: 'inadequate or poor', action: 5 },
      { name: 'defined but not used', action: 1 },
      { name: 'good or robust', action: 0.8 },
    ],
  },
};

export const SPAR_NOMINAL = { action: 1e-3, diagnosis: 1e-2 };
/** SPAR-H does not permit a human action below this floor. */
export const SPAR_FLOOR = 1e-5;

/* ------------------------------------------------------------------- THERP */

/**
 * NUREG/CR-1278 Appendix G Table G-1, general error rate estimates.
 * Keyed by error type, which is exactly how a procedure step's error surface
 * is written, so the base rate does not have to be invented.
 */
export const THERP_BASE: Record<string, { p: number; note: string }> = {
  wrong_key_switch: { p: 1e-4, note: 'wrong key-protected switch instead of the key switch' },
  dissimilar_switch: { p: 1e-3, note: 'incorrect operation of a dissimilar switch' },
  commission_label: { p: 3e-3, note: 'general error of commission, misreading a label' },
  omission_no_display: { p: 1e-2, note: 'general error of omission where no status display exists' },
  omission_in_procedure: { p: 3e-3, note: 'omission of a step inside a documented procedure' },
  omission_outside_procedure: { p: 1e-2, note: 'omission of a step not cued by the procedure' },
  arithmetic_self_check: { p: 3e-2, note: 'simple arithmetic with self-checking' },
  note_already_positioned: { p: 1e-1, note: 'failure to note that a device is already positioned' },
  monitor_misses_error: { p: 1e-1, note: 'monitor fails to recognise an initial error' },
  different_shift_no_check: { p: 1e-1, note: 'different shift fails to check what the previous shift did' },
  walk_around_miss: { p: 5e-1, note: 'failure to detect an incorrect alignment on a walk-around check' },
  first_60s_extreme_stress: { p: 1.0, note: 'first 60 s of extreme stress: action assumed to fail' },
  five_min_extreme_stress: { p: 0.9, note: 'after five minutes of extreme stress' },
  thirty_min_stress: { p: 1e-1, note: 'after thirty minutes under sustained stress' },
  hours_recovery: { p: 1e-2, note: 'after several hours, performance recovers towards nominal' },
  general_first_estimate: { p: 3e-3, note: 'nominal general HEP for a first estimate' },
};

/** THERP's own instruction: values are purposely conservative, 1960s vintage. */
export const THERP_ERROR_FACTOR = 10;

/* ------------------------------------------------------------------- HEART */

/** Generic task types and generic error probilities, as reprinted in HSE RR679. */
export const HEART_GTT: Record<string, { gep: number; label: string }> = {
  A: { gep: 0.55, label: 'perform an unfamiliar task at speed' },
  B: { gep: 0.26, label: 'restore a system to service without written procedures' },
  C: { gep: 0.16, label: 'complex comprehension of a fault condition' },
  D: { gep: 0.09, label: 'response to a fairly simple or rapid action, situation not anticipated or trained for' },
  M: { gep: 0.03, label: 'misread or miss-read a digital display / miscellaneous' },
  E: { gep: 0.02, label: 'routine actions to a well-designed software interface / low skill routine' },
  F: { gep: 0.003, label: 'restore or shift a system to or from storage/operating mode following recognised procedures with checking' },
  G: { gep: 0.0004, label: 'fully understood, familiar task, adequately designed for human performance' },
  H: { gep: 0.00002, label: 'act correctly in response to a system demand' },
};

/**
 * Error producing condition maximum factors. The range 1.2 to 30 is published
 * (NARA, the HEART successor, in the IAEA methodology annex); the assignment of
 * a specific factor to a named site condition is our analyst choice inside
 * that range and is reported as such.
 */
export const HEART_EPC_MAX = 30;

/** Assumed Probabilistic Impact of the EPC on the task - HEART's APOA. */
export const APOA_BY_LEVEL = [0, 0.25, 0.5, 0.75, 1.0];

/* --------------------------------------------------------------- interface */

export type PsfId = SparPsfId;

export interface PsfState {
  psf: PsfId;
  /** index into that PSF's level list; chosen by the condition mapper */
  levelIndex: number;
  /** 1 present, 2 marked, 3 severe. Used for HEART's APOA and shown in the UI */
  severity: number;
  /** why, for the audit trail */
  why: string;
}

export interface HepInput {
  method: HraMethod;
  kind: ActionKind;
  /** how many near-identical devices the action requires a choice between */
  similarity?: number;
  /** whether the step is written in the controlled procedure */
  insideProcedure?: boolean;
  psfs: PsfState[];
  /** HEART generic task type id; defaulted from the action kind */
  gtt?: string;
  /** maximum EPC factor for HEART, default within the published range */
  epcMax?: number;
}

export interface HepRow {
  id: string;
  label: string;
  level: string;
  mult: number;
}

export interface HepResult {
  p: number;
  /** product of the shaping multipliers that were applied */
  multiplier: number;
  /** order-of-magnitude band around p, per the source guidance */
  lo: number;
  hi: number;
  nominal: number;
  rows: HepRow[];
  method: HraMethod;
  /** SPAR-H adjustment factor applied (three or more negative PSFs) */
  adjusted: boolean;
  basis: string;
}

function isDiagnosis(kind: ActionKind): boolean {
  // SPAR-H reserves the diagnosis nominal rate for establishing the state of a
  // system. Pressing an emergency stop is a trained motor action even when the
  // recognition around it is hard, so it keeps the action rate.
  return kind === 'verify';
}

function nominalFor(input: HepInput): { nominal: number; basis: string } {
  if (input.method === 'sparh') {
    return isDiagnosis(input.kind)
      ? { nominal: SPAR_NOMINAL.diagnosis, basis: 'SPAR-H nominal diagnosis HEP 1.0E-02 (CR-6883)' }
      : { nominal: SPAR_NOMINAL.action, basis: 'SPAR-H nominal action HEP 1.0E-03 (CR-6883)' };
  }
  if (input.method === 'heart') {
    const gtt = input.gtt ?? defaultGtt(input.kind);
    const rec = HEART_GTT[gtt];
    return { nominal: rec.gep, basis: `HEART generic task type ${gtt}: ${rec.label}` };
  }
  // THERP: base rate chosen by the shape of the action
  const sim = input.similarity ?? 1;
  if (input.kind === 'verify') {
    return { nominal: THERP_BASE.walk_around_miss.p, basis: 'THERP Table G-1: failure to detect an incorrect alignment on a walk-around check (5E-01)' };
  }
  if (input.kind === 'monitor') {
    return { nominal: THERP_BASE.monitor_misses_error.p, basis: 'THERP Table G-1: monitor fails to recognise an initial error (1E-01)' };
  }
  if (input.kind === 'recover') {
    return { nominal: THERP_BASE.thirty_min_stress.p, basis: 'THERP Table G-1: 1E-01 after thirty minutes under sustained stress' };
  }
  if (input.kind === 'actuate' && sim > 1) {
    // WASH-1400 rule of thumb, reprinted in CR-1278: the chance of picking the
    // wrong one among n confusable devices rises with n
    const base = THERP_BASE.dissimilar_switch.p;
    return { nominal: Math.min(0.5, base * ((sim - 1) / sim) * 4), basis: `THERP Table G-1 dissimilar switch 1E-03 scaled for ${sim} confusable devices` };
  }
  if (input.kind === 'actuate') {
    return { nominal: THERP_BASE.commission_label.p, basis: 'THERP Table G-1: general error of commission, misreading a label (3E-03)' };
  }
  if (input.kind === 'communicate') {
    return { nominal: THERP_BASE.arithmetic_self_check.p, basis: 'THERP Table G-1: 3E-02 for a simple transfer with self-checking' };
  }
  return {
    nominal: input.insideProcedure ? THERP_BASE.omission_in_procedure.p : THERP_BASE.omission_outside_procedure.p,
    basis: input.insideProcedure
      ? 'THERP Table G-1: omission of a step within a documented procedure (3E-03)'
      : 'THERP Table G-1: omission of a step not cued by the procedure (1E-02)',
  };
}

function defaultGtt(kind: ActionKind): string {
  switch (kind) {
    case 'actuate': return 'G';
    case 'verify': return 'F';
    case 'authorise': return 'E';
    case 'communicate': return 'M';
    case 'monitor': return 'D';
    case 'recover': return 'C';
  }
}

/**
 * The SPAR-H adjustment factor. Multiplying eight graded PSFs can produce an
 * absurd number, so when three or more PSFs are negative the product C is run
 * through a saturating transform instead: HEP = NHEP*C / (1 + NHEP*(C-1)).
 * This is published, not invented, and it is why a badly-shaped step lands near
 * 0.8 rather than at 40.
 */
export function sparAdjustment(nominal: number, c: number): number {
  return (nominal * c) / (1 + nominal * (c - 1));
}

/**
 * Compute the human error probability for one performance of one action.
 * Deterministic and fully traceable: every contributing table row is returned,
 * so the UI can show the derivation instead of a number nobody can argue with.
 */
export function computeHep(input: HepInput): HepResult {
  const { nominal, basis } = nominalFor(input);
  const rows: HepRow[] = [];
  const fails = input.method === 'sparh';

  for (const st of input.psfs) {
    const def = SPAR_PSFs[st.psf];
    if (!def) continue;
    const lvl = def.levels[Math.max(0, Math.min(def.levels.length - 1, st.levelIndex))];
    if (lvl.fails && fails) {
      return {
        p: 0.99, lo: 0.5, hi: 0.99, nominal, multiplier: 1, rows: [...rows, { id: st.psf, label: def.label, level: lvl.name, mult: 1 }],
        method: input.method, adjusted: false,
        basis: `${basis}; ${def.label} at "${lvl.name}" makes the action unachievable, so it is scored as a failure`,
      };
    }
    const mult = isDiagnosis(input.kind) && lvl.diagnosis !== undefined ? lvl.diagnosis : lvl.action;
    rows.push({ id: st.psf, label: def.label, level: lvl.name, mult });
  }

  let p: number;
  let adjusted = false;
  let c = 1;
  for (const r of rows) c *= r.mult;

  if (input.method === 'heart') {
    // HEART scales each error producing condition by its assumed probabilistic
    // impact on the task (APOA) and caps the result at 1, as RR679 instructs.
    // The maximum factor of an individual condition is taken from the published
    // 1.2 - 30 band rather than a single global value, because treating every
    // condition as a x30 one is how a method ends up reporting 100%.
    const max = input.epcMax ?? HEART_EPC_MAX;
    let f = 1;
    for (let i = 0; i < input.psfs.length; i++) {
      const st = input.psfs[i];
      const own = Math.min(max, Math.max(1.2, SPAR_PSFs[st.psf].levels[st.levelIndex].action));
      const apoa = APOA_BY_LEVEL[Math.min(4, Math.max(1, Math.round(st.severity)))];
      const epMult = (own - 1) * apoa + 1;
      f *= epMult;
      rows[i] = { ...rows[i], level: `EPC max ${own} at APOA ${apoa.toFixed(2)}`, mult: epMult };
    }
    p = Math.min(1, nominal * f);
    c = f;
  } else {
    const negatives = rows.filter((r) => r.mult > 1).length;
    if (negatives >= 3 && c > 1) {
      p = sparAdjustment(nominal, c);
      adjusted = true;
    } else {
      p = nominal * c;
    }
    if (input.method === 'sparh') p = Math.max(SPAR_FLOOR, Math.min(0.98, p));
    else p = Math.min(0.98, p);
  }

  const ef = input.method === 'therp' ? THERP_ERROR_FACTOR : input.method === 'sparh' ? 3 : 5;
  return {
    p,
    lo: Math.max(1e-6, p / ef),
    hi: Math.min(0.99, p * ef),
    nominal,
    multiplier: c,
    rows,
    method: input.method,
    adjusted,
    basis: `${basis}${adjusted ? '; SPAR-H adjustment factor applied (three or more negative PSFs)' : ''}`,
  };
}

/**
 * Probability that an independent verification actually detects a deviation
 * that is present. Modelled as an action in its own right, so "get it checked"
 * is only ever as good as the checker.
 */
export function detectionProbability(input: HepInput): number {
  const miss = computeHep(input);
  return Math.max(0.05, Math.min(0.999, 1 - miss.p));
}

/**
 * Fail on demand rates for the protective functions of a transfer, in the
 * vocabulary of the overfill-protection literature: an alarm that shares the
 * control system's measurement is not an independent function.
 */
export const PROTECTION_FOD = {
  soft_alarm: 0.1,
  independent_switch: 0.01,
  independent_switch_proven: 0.001,
  interlock: 0.01,
  operator_response: 0.1,
  containment: 0.02,
} as const;
