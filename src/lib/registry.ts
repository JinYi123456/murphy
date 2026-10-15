import opTrf from '../../data/procedures/OP-TRF-014.json';
import opHt from '../../data/procedures/OP-HT-006.json';
import opHt021 from '../../data/procedures/OP-HT-021.json';
import personasRaw from '../../data/personas.json';
import plantsRaw from '../../data/plants.json';
import { loadProcedure } from '../engine/model';
import { applyIntervention, materialiseVerifications, INTERVENTIONS } from '../engine/repair';
import type { Intervention, DraftProcedure } from '../engine/repair';
import type { HraMethod } from '../engine/hra';
import type { PersonaTraits, PlantConfig, Procedure, RunConfig } from '../engine/types';

export const PROCEDURES: Procedure[] = [loadProcedure(opTrf), loadProcedure(opHt), loadProcedure(opHt021)];
export const PERSONAS = personasRaw as PersonaTraits[];
export const PLANTS = plantsRaw as unknown as PlantConfig[];

export function procedureById(id: string): Procedure {
  const p = PROCEDURES.find((x) => x.id === id);
  if (!p) throw new Error(`unknown procedure ${id}`);
  return p;
}

export function personaById(id: string): PersonaTraits {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown persona ${id}`);
  return p;
}

export function plantById(id: string): PlantConfig {
  const p = PLANTS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown plant ${id}`);
  return p;
}

export interface ConsoleConfig {
  procedureId: string;
  personaId: string;
  plantId: string;
  method: HraMethod;
  /** applied control ids, in order */
  controls: string[];
  n: number;
  seed: string;
}

export const DEFAULT_CONFIG: ConsoleConfig = {
  procedureId: 'OP-TRF-014',
  personaId: 'daytime_competent',
  plantId: 'tk_asdesigned',
  method: 'sparh',
  controls: [],
  n: 6000,
  seed: 'murphy-default',
};

/**
 * Build the run configuration for a variant.
 *
 * Controls are applied in the order the analyst stacked them, and the
 * verification steps an independent-check control asks for are spliced into the
 * sequence here rather than at authoring time: the procedure the operator reads
 * and the procedure the simulator runs must be the same document.
 */
export function buildDraft(cfg: ConsoleConfig): DraftProcedure {
  const base: DraftProcedure = {
    procedure: procedureById(cfg.procedureId),
    persona: personaById(cfg.personaId),
    plant: plantById(cfg.plantId),
    addedSeconds: 0,
    annualCostEur: 0,
    applied: [],
  };
  let draft = base;
  for (const id of cfg.controls) {
    const int = INTERVENTIONS.find((x) => x.id === id) as Intervention | undefined;
    if (!int) continue;
    const next = applyIntervention(draft, int);
    if (next) draft = next;
  }
  return { ...draft, procedure: materialiseVerifications(draft.procedure) };
}

export function buildRunConfig(cfg: ConsoleConfig): RunConfig {
  const draft = buildDraft(cfg);
  return {
    procedure: draft.procedure,
    persona: draft.persona,
    plant: draft.plant,
    method: cfg.method,
    seed: cfg.seed,
  };
}

export function variantLabel(cfg: ConsoleConfig): string {
  const p = procedureById(cfg.procedureId);
  return [p.id, p.revision, cfg.controls.join('_') || 'baseline'].join('/');
}

export const CONTROL_CATALOGUE = INTERVENTIONS;
