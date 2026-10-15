import { bind } from './conditions';
import type { ConditionId } from './conditions';
import { SPAR_PSFs } from './hra';
import type { PsfState } from './hra';
import type { PersonaTraits, PlantConfig, Step } from './types';

/**
 * Filling the shaping-factor worksheet.
 *
 * A real SPAR-H assessment scores all eight factors for every action, not only
 * the ones that something bad triggered. So this starts from a baseline derived
 * from the step, the crew and the plant - which for a trained operator working
 * from a clear written procedure with a readable gauge is genuinely *better*
 * than nominal, and that is why the same procedure can be safe in one pair of
 * hands and not in another.
 *
 * Then it applies the active conditions, and finally it applies one constraint
 * that the method itself insists on but that an automated pass cannot be trusted
 * to respect:
 *
 *   SPAR-H performance shaping factors are not independent. "Fatigued",
 *   "rushed" and "poor procedure" are three descriptions of one situation, and
 *   multiplying all three re-counts the same cause two or three times over.
 *   NUREG-1842 and the IAEA methodology annex both list this as the standing
 *   criticism of PSF-based methods.
 *
 * So at most three negative factors are allowed to act on a single step: the
 * three strongest. Everything else is recorded as suppressed and shown in the
 * audit, because the honest thing is not to hide the judgement but to put it on
 * screen where somebody who disagrees can change it.
 */

export const MAX_NEGATIVE_PSFS = 3;

export interface Assessment {
  rows: PsfState[];
  suppressed: { psf: PsfState['psf']; levelIndex: number; why: string }[];
  baseline: string[];
}

interface BaselineInput {
  step: Step;
  persona: PersonaTraits;
  plant: PlantConfig;
  alarmRinging: boolean;
}

const PSF_ORDER: PsfState['psf'][] = ['AVL', 'STR', 'CX', 'E-T', 'PRU', 'HCI', 'FFD', 'WMP'];

function baselineRow(input: BaselineInput): Record<PsfState['psf'], { levelIndex: number; why: string }> {
  const { step, persona, plant } = input;
  const out: Record<PsfState['psf'], { levelIndex: number; why: string }> = {
    AVL: { levelIndex: 2, why: 'nominal: the step is scheduled with time to perform it' },
    STR: { levelIndex: 2, why: 'nominal working conditions' },
    CX: {
      levelIndex: step.kind === 'actuate' ? 3 : 2,
      why: step.kind === 'actuate' ? 'single well-defined device action' : 'step needs interpretation of a state, not just a movement',
    },
    'E-T': {
      levelIndex: persona.experienceY >= 8 && persona.runsBefore >= 100 && persona.qualificationCurrent
        ? 4 : persona.experienceY >= 4 && persona.qualificationCurrent ? 3 : 2,
      why: `${persona.experienceY} years, ${persona.runsBefore} previous runs of this procedure`,
    },
    PRU: {
      levelIndex: step.applies || step.verify || step.watch ? 4 : 3,
      why: step.applies || step.verify || step.watch
        ? 'step is written in the controlled procedure with a defined outcome'
        : 'step is a judgement the procedure cannot fully script',
    },
    HCI: {
      levelIndex: cueLevel(step),
      why: `the operator relies on a ${step.cue}`,
    },
    FFD: { levelIndex: 2, why: 'rested and fit for duty' },
    WMP: {
      levelIndex: plant.provenRecent && persona.teamReadiness >= 0.8 ? 2 : 1,
      why: plant.provenRecent
        ? 'work process holds: protective devices proved, handover disciplined'
        : 'work process leaky: proof tests and handover not current',
    },
  };
  return out;
}

/**
 * Cue quality is the single most controllable thing in a field procedure, so it
 * is scored explicitly rather than left to the analyst's mood.
 */
function cueLevel(step: Step): number {
  switch (step.cue) {
    case 'gauge':
    case 'light': return 3;
    case 'checklist': return 3;
    case 'physical': return 3;
    case 'label': return 2;
    case 'verbal': return 1;
    case 'document': return 2;
    case 'memory': return 1;
  }
}

/**
 * Full PSF assessment for one performance of one step.
 * `conditions` are the active site conditions with their severities.
 */
export function assess(
  input: BaselineInput,
  conditions: Partial<Record<ConditionId, number>>,
): Assessment {
  const chosen: Record<string, PsfState> = {};
  const base = baselineRow(input);
  const baseline: string[] = [];
  for (const psf of PSF_ORDER) {
    const b = base[psf];
    chosen[psf] = { psf, levelIndex: b.levelIndex, severity: 0, why: `baseline - ${b.why}` };
    baseline.push(`${psf} ${SPAR_PSFs[psf].levels[b.levelIndex].name} (${SPAR_PSFs[psf].levels[b.levelIndex].action})`);
  }

  for (const cond of Object.keys(conditions) as ConditionId[]) {
    const sev = conditions[cond];
    if (!sev || sev <= 0) continue;
    for (const b of bind(cond, sev)) {
      const cur = chosen[b.psf];
      const curMult = SPAR_PSFs[b.psf].levels[cur.levelIndex].action;
      const newMult = SPAR_PSFs[b.psf].levels[b.levelIndex].action;
      // only ever move a factor in the error-prone direction
      if (newMult > curMult) {
        chosen[b.psf] = { psf: b.psf, levelIndex: b.levelIndex, severity: b.severity, why: b.why };
      }
    }
  }

  const all = PSF_ORDER.map((p) => chosen[p]);
  const negatives = all
    .filter((r) => SPAR_PSFs[r.psf].levels[r.levelIndex].action > 1)
    .sort((a, b) => SPAR_PSFs[b.psf].levels[b.levelIndex].action - SPAR_PSFs[a.psf].levels[a.levelIndex].action);

  const keep = new Set(negatives.slice(0, MAX_NEGATIVE_PSFS).map((r) => r.psf));
  const rows: PsfState[] = [];
  const suppressed: Assessment['suppressed'] = [];
  for (const r of all) {
    const mult = SPAR_PSFs[r.psf].levels[r.levelIndex].action;
    if (mult > 1 && !keep.has(r.psf)) {
      suppressed.push({ psf: r.psf, levelIndex: r.levelIndex, why: r.why });
      // held at nominal rather than deleted, so the count stays honest
      rows.push({ ...r, levelIndex: nominalIndex(r.psf), why: `${r.why} [held at nominal: more than ${MAX_NEGATIVE_PSFS} negative factors would re-count the same cause]` });
      continue;
    }
    rows.push(r);
  }
  return { rows, suppressed, baseline };
}

function nominalIndex(psf: PsfState['psf']): number {
  const levels = SPAR_PSFs[psf].levels;
  for (let i = 0; i < levels.length; i++) if (levels[i].action === 1 && !levels[i].fails) return i;
  return levels.findIndex((l) => l.action === 1 && !l.fails);
}
