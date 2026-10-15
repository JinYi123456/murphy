import { ALL_CONDITIONS, isValidCondition } from './conditions';
import type { ConditionId } from './conditions';
import { getTwin } from './twins/index';
import type { ActionKind } from './hra';
import type { Procedure, Step } from './types';

/**
 * Model integrity gate.
 *
 * A parsed procedure is a hypothesis about a plant, usually produced by
 * something that cannot be trusted to read carefully: an OCR pass, a model, a
 * tired engineer. Nothing enters the simulator that has not been checked
 * against the twin it claims to operate. An unknown variable name is not a
 * warning here - it is the difference between a finding and a fiction.
 */

const KINDS: ActionKind[] = ['actuate', 'verify', 'communicate', 'authorise', 'monitor', 'recover'];
const CUES = ['label', 'gauge', 'light', 'checklist', 'memory', 'physical', 'verbal', 'document'];
const ERROR_KINDS = ['omission', 'commission', 'wrong_target', 'wrong_direction', 'out_of_sequence', 'incomplete', 'premature', 'delayed_response', 'misread'];

export interface ModelReport {
  ok: boolean;
  errors: string[];
  notes: string[];
  procedure?: Procedure;
}

export function inspectModel(raw: unknown): ModelReport {
  const errors: string[] = [];
  const notes: string[] = [];
  const j = raw as Partial<Procedure> & { steps?: unknown[] };

  if (!j || typeof j !== 'object') return { ok: false, errors: ['model is not an object'], notes };
  if (!j.id) errors.push('missing id');
  if (!j.twin) errors.push('missing twin');
  if (!Array.isArray(j.steps) || j.steps.length === 0) errors.push('steps must be a non-empty array');
  if (errors.length) return { ok: false, errors, notes };

  let twin;
  try {
    twin = getTwin(j.twin!);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message], notes };
  }

  const steps = j.steps as Step[];
  const seen = new Set<string>();
  const order = new Map<string, number>();
  steps.forEach((s, i) => order.set(s.id, i));

  for (const s of steps) {
    if (!s.id) { errors.push('a step has no id'); continue; }
    if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
    seen.add(s.id);
    if (!KINDS.includes(s.kind)) errors.push(`${s.id}: kind "${s.kind}" is not one of ${KINDS.join(', ')}`);
    if (!CUES.includes(s.cue)) errors.push(`${s.id}: unknown cue "${s.cue}"`);
    if (!(s.durS > 0)) errors.push(`${s.id}: durS must be positive`);
    for (const c of s.cond ?? []) if (!isValidCondition(c)) errors.push(`${s.id}: unknown condition "${c}"`);

    const keys = [...Object.keys(s.applies ?? {})];
    for (const e of s.errors ?? []) {
      keys.push(...Object.keys(e.patch?.set ?? {}));
      if (!(e.weight >= 0)) errors.push(`${s.id}/${e.id}: weight must be >= 0`);
      if (!ERROR_KINDS.includes(e.kind)) errors.push(`${s.id}/${e.id}: unknown error kind "${e.kind}"`);
      if (!e.text?.trim()) errors.push(`${s.id}/${e.id}: an error mode with no description`);
    }
    for (const k of keys) {
      if (twin.discIndex(k) < 0 && twin.varIndex(k) < 0) {
        errors.push(`${s.id}: patch key "${k}" does not exist on twin "${twin.id}"`);
      }
    }

    if (s.verify) {
      for (const of of s.verify.of) {
        const at = order.get(of);
        if (at === undefined) errors.push(`${s.id}: verifies unknown step "${of}"`);
        else if (at >= order.get(s.id)!) errors.push(`${s.id}: verifies step "${of}" which is not earlier in the sequence`);
      }
    }
    if (s.watch) {
      const name = s.watch.var.replace(/^indicated:/, '');
      if (twin.varIndex(name) < 0) errors.push(`${s.id}: watch variable "${name}" is not a process variable on ${twin.id}`);
      if (s.watch.onHit) {
        for (const k of Object.keys(s.watch.onHit)) {
          if (twin.discIndex(k) < 0 && twin.varIndex(k) < 0) errors.push(`${s.id}: onHit key "${k}" does not exist on twin "${twin.id}"`);
        }
      }
    }
    if (s.deadline && twin.varIndex(s.deadline.var) < 0) errors.push(`${s.id}: deadline variable "${s.deadline.var}" unknown`);
  }

  for (const w of j.warnings ?? []) {
    for (const sid of w.steps) if (!seen.has(sid)) errors.push(`warning ${w.id}: references unknown step "${sid}"`);
    if (!isValidCondition(w.cond)) errors.push(`warning ${w.id}: unknown condition "${w.cond}"`);
  }

  const reachable = steps.filter((s) => (s.errors?.length ?? 0) > 0).length;
  notes.push(`${steps.length} steps, ${reachable} with a modelled error surface`);
  notes.push(`conditions used: ${[...new Set(steps.flatMap((s) => s.cond ?? []))].length} of ${ALL_CONDITIONS.length}`);
  const refs = new Set<string>();
  for (const s of steps) for (const k of Object.keys(s.applies ?? {})) refs.add(k);
  notes.push(`operates ${refs.size} distinct plant variables on ${twin.id}`);

  return { ok: errors.length === 0, errors, notes, procedure: j as Procedure };
}

export function loadProcedure(raw: unknown): Procedure {
  const r = inspectModel(raw);
  if (!r.ok || !r.procedure) throw new Error(`invalid procedure model:\n  ${r.errors.join('\n  ')}`);
  return r.procedure;
}

/** Conditions actually used across a set of procedures, for the coverage display. */
export function conditionUsage(procedures: Procedure[]): Record<ConditionId, number> {
  const out = {} as Record<ConditionId, number>;
  for (const c of ALL_CONDITIONS) out[c] = 0;
  for (const p of procedures) for (const s of p.steps) for (const c of s.cond ?? []) out[c]++;
  return out;
}
