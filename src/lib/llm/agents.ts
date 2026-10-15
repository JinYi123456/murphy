import { chat, extractJsonBlock, availability, type ChatMessage, type ChatResult } from './client';
import { inspectModel } from '../../engine/model';
import { getTwin } from '../../engine/twins/index';
import { isValidCondition } from '../../engine/conditions';
import { HEART_GTT } from '../../engine/hra';
import { interventionById } from '../../engine/repair';
import type { ConditionId } from '../../engine/conditions';
import type { ActionKind, HraMethod } from '../../engine/hra';
import type {
  DiscretePatch, ErrorAlternative, ErrorKind, PersonaTraits, PlantConfig, Procedure, Step,
} from '../../engine/types';
import type { TwinDef } from '../../engine/twins/twin';
import type { SummaryDto } from '../dto';
import type { CandidateTrial } from '../fuzz';
import type { VariantVerdict } from '../../engine/batch';

/**
 * The four model-backed agents.
 *
 * Each one is a professional task with a fixed JSON contract, and each one has a
 * deterministic `fallback`. The fallback is not an error page: a plant without a
 * GPU still gets a compiled procedure, a scenario skeleton, a review that argues
 * with the finding, and a change order with real figures in it. What it does not
 * get is prose that pretends somebody thought about this particular tank.
 *
 * The accounting returned alongside every result exists because the product
 * claims things about how procedures fail. A user has to be able to see whether
 * the sentence in front of them came from a served 8B model or from a rule an
 * analyst wrote, and no result should ever be able to hide that.
 */

export interface LlmProvenance {
  /** true only when a served model actually wrote the result */
  used: boolean;
  model?: string;
  endpoint?: string;
  tokens?: { prompt: number; completion: number };
  latencyMs?: number;
  /** why the deterministic path ran instead, whenever it did */
  reason?: string;
  calls?: number;
}

export class Accounting {
  private calls = 0;
  private prompt = 0;
  private completion = 0;
  private latency = 0;
  private model?: string;
  private endpoint?: string;

  record(res: ChatResult): void {
    this.calls++;
    this.prompt += res.promptTokens;
    this.completion += res.completionTokens;
    this.latency += res.latencyMs;
    this.model = res.model;
    this.endpoint = res.endpoint;
  }

  provenance(reason?: string): LlmProvenance {
    const p: LlmProvenance = { used: this.calls > 0 };
    if (this.model) p.model = this.model;
    if (this.endpoint) p.endpoint = this.endpoint;
    if (this.calls) p.tokens = { prompt: this.prompt, completion: this.completion };
    if (this.calls) p.latencyMs = this.latency;
    if (reason) p.reason = reason;
    if (this.calls > 1) p.calls = this.calls;
    return p;
  }

  /**
   * The model was consulted, spent tokens, and its answer was not used.
   *
   * `used` is an authorship claim, not a traffic claim: a panel that says "model"
   * over a rule-generated artefact is the exact failure this field exists to prevent.
   */
  decline(reason: string): LlmProvenance {
    return { ...this.provenance(reason), used: false };
  }
}

export interface AgentOutcome<T> {
  result: T;
  llm: LlmProvenance;
}

/* ------------------------------------------------------------------ shared */

/** Mirrors the private lists in model.ts; inspectModel stays the authority on anything missed here. */
const KINDS: ActionKind[] = ['actuate', 'verify', 'communicate', 'authorise', 'monitor', 'recover'];
const CUES: Step['cue'][] = ['label', 'gauge', 'light', 'checklist', 'memory', 'physical', 'verbal', 'document'];
const ERROR_KINDS: ErrorKind[] = ['omission', 'commission', 'wrong_target', 'wrong_direction', 'out_of_sequence', 'incomplete', 'premature', 'delayed_response', 'misread'];
const SOURCES: ErrorAlternative['source'][] = ['analyst', 'model', 'model+review'];
const OPS: ('lt' | 'lte' | 'gt' | 'gte' | 'eq')[] = ['lt', 'lte', 'gt', 'gte', 'eq'];

const DEFAULT_DUR: Record<ActionKind, number> = {
  actuate: 90, verify: 120, communicate: 90, authorise: 150, monitor: 60, recover: 30,
};

/**
 * Verb-and-cue reading of a procedure line.
 *
 * Used by both the offline parser and the sanitiser, so a step the model left
 * without a kind is classified the same way a step the offline parser found is.
 */
function inferKind(text: string): ActionKind {
  const t = text.toLowerCase();
  if (/^(if|should|in the event)/.test(t) || /emergency|release[ds] on|goes wrong/.test(t)) return 'recover';
  if (/\b(watch|monitor|observe|wait until|until the|is rising)\b/.test(t)) return 'monitor';
  if (/\b(record|enter|log|note|update the|initial|call|report|ask|notify)\b/.test(t)) return 'communicate';
  if (/\b(obtain a|permit|authoris|authoriz|approval|sign off)\b/.test(t)) return 'authorise';
  if (/\b(open|close|start|stop|isolate|line up|align|turn|press|connect|disconnect|drain|remove|fit)\b/.test(t)) return 'actuate';
  if (/\b(confirm|check|verify|ensure|inspect|walk|test|examine|look)\b/.test(t)) return 'verify';
  return 'verify';
}

function inferCue(text: string): Step['cue'] {
  const t = text.toLowerCase();
  if (/\b(light|annunciat|alarm|indicat\w* (is|are) on)\b/.test(t)) return 'light';
  if (/\b(gauge|meter|indicator|reads|readings?|totalis|thermocouple|level on the)\b/.test(t)) return 'gauge';
  if (/\b(permit|register|dispatch note|log\b|status board|document|form|labelled list)\b/.test(t)) return 'document';
  if (/\b(call|radio|ask|inform|tell)\b/.test(t)) return 'verbal';
  if (/\b(initial|sign|tick|checklist)\b/.test(t)) return 'checklist';
  if (/\b(walk|visually|hose|coupling|bond|earth|tray|handle|valve \w+ is)\b/.test(t)) return 'physical';
  if (/\b(v\d+|p-\d+|tk-\d+|ls\w*|lt-\d+)\b/.test(t)) return 'label';
  return 'physical';
}

/**
 * A variable name is a claim about the plant, and a model reading a document has
 * no way to know the plant's tag list. Unknown keys are removed here rather than
 * reported as errors, because the alternative - refusing the whole compilation -
 * throws away a usable procedure over one invented tag.
 */
function dropUnknownKeys(twin: TwinDef, rec: unknown, where: string, dropped: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!rec || typeof rec !== 'object') return out;
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    const known = twin.discIndex(k) >= 0 || twin.varIndex(k) >= 0;
    if (!known || typeof v !== 'number' || !Number.isFinite(v)) {
      dropped.push(`${where}: "${k}" is not a ${twin.id} variable`);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function knownVar(twin: TwinDef, name: unknown): string | null {
  if (typeof name !== 'string' || !name) return null;
  const bare = name.replace(/^indicated:/, '');
  if (twin.varIndex(bare) < 0) return null;
  return name;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function int(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/* ---------------------------------------------------- a) procedure compiler */

export interface ParseResult {
  procedure: Procedure;
  integrity: { ok: boolean; errors: string[]; notes: string[] };
  /** keys and references removed because the twin or the sequence does not admit them */
  dropped: string[];
  /** who actually wrote this model */
  author: 'model' | 'offline';
  /** correction rounds spent on the validator's complaints */
  corrections: number;
}

const PARSE_SYSTEM = `You are a technical-writing analyst. You compile controlled operating procedures from power, process, rail and marine sites into a single JSON model for a procedural-fuzzing engine. You have read several thousand field procedures and you do not embellish them.

The model:
{
 "id": "document number", "title": "one line", "twin": "tank_transfer | furnace_lightoff",
 "revision": "as printed on the document", "language": "en", "roles": ["..."], "summary": "what the procedure achieves, with the quantities that decide it",
 "warnings": [{"id":"W1","label":"what in this wording puts a crew at risk","cond":"<condition>","level":1|2|3,"steps":["step id"]}],
 "steps": [{"id":"d1","title":"imperative, <= 12 words","text":"the instruction as the operator reads it","role":"field operator","cue":"<cue>","kind":"<kind>","durS":seconds,"cond":["<condition>"],"similarity":count of near-identical devices,"gtt":"HEART letter A|B|C|D|E|F|G|M",
   "errors":[{"id":"d1e1","kind":"<error kind>","weight":0-100,"text":"how a real crew makes this mistake on this site","source":"model"}],
   "verify":{"of":["earlier step id"],"via":"<cue>","kind":"<kind>"},
   "watch":{"var":"process variable","atLeast":number,"alt":{"var":"...","atLeast":number},"onHit":{"FLAG":0},"maxWaitS":seconds,"lateMaxS":seconds},
   "until":{"var":"process variable","atLeast":number},
   "guard":{"var":"process variable","op":"lt|lte|gt|gte|eq","value":number},
   "deadline":{"var":"process variable","op":"...","value":number},
   "xcheck":true,
   "emergency":{"maxResponseS":seconds,"onHit":{"FLAG":0}}}]
}

Enumerations - use nothing else:
cue: label | gauge | light | checklist | memory | physical | verbal | document
kind: actuate | verify | communicate | authorise | monitor | recover
error kind: omission | commission | wrong_target | wrong_direction | out_of_sequence | incomplete | premature | delayed_response | misread
condition: novel_task low_experience confusable_device ambiguous_wording memory_load poor_procedure timing_critical time_pressure distraction interruption fatigue teamwork mistrust unprepared_exception situation_awareness post_maintenance_state language_barrier incomplete_function_test absent_cue

Rules, in order of how badly they break the run if you ignore them:
1. You have not been given the plant's tag list. Never invent one. Every step carries "applies": {} and states the intended device change in the step text instead. A tag you make up silently retargets the physics.
2. Only a human analyst can name a plant variable, so you do not either: onHit, watch.var, until.var, guard.var and deadline.var are omitted, not guessed. Emit a "watch" only when the document gives a readable criterion AND you can name it from the twin's published state list; otherwise record the criterion in the step text.
3. Keep document order and one step per printed instruction. Number steps d1, d2, ... in that order. Split nothing, merge nothing, and never renumber.
4. Every step with a physical or judgemental consequence needs errors[]: the typed ways a competent crew gets that exact step wrong. Weight them within the step, largest first, weights summing to 100. Use out_of_sequence, premature and delayed_response where the document's own order or timing is what fails. Write text as an account of a person doing it, not as a category label.
5. durS is the realistic field time in whole seconds, not the ideal one.
6. warnings[] are defects of the document: wording that admits two readings, a check that depends on a cue that is not at the point of action, a conditional instruction with no test. Each names the steps it lands on.
7. verbatim text beats your summary of it. If the document says "if in doubt", keep "if in doubt".
Output one JSON object only.`;

export async function parseProcedure(markdown: string): Promise<AgentOutcome<ParseResult>> {
  const acc = new Accounting();
  const doc = markdown.trim();
  let corrections = 0;

  /**
   * Degrade to the rule compiler.
   *
   * `used` is forced false even when the model answered: it was consulted and
   * spent tokens, but the procedure on screen is not its work. Authorship and
   * traffic are different claims and the panel has to be able to say either.
   */
  const fallback = (reason: string): AgentOutcome<ParseResult> => {
    const offline = offlineParse(markdown);
    return {
      result: { ...offline, corrections, dropped: [...offline.dropped, `fallback: ${reason}`] },
      llm: acc.decline(reason),
    };
  };

  if (!doc) return fallback('the request carried no document');

  const gate = await availability();
  if (!gate.ok) return fallback(`offline path: ${gate.reason}`);

  // a compiled procedure is one artefact per printed step, so the 900 token default
  // truncates it mid-document; the answer is worthless in pieces
  const budget = Math.max(2400, Number(process.env.AMD_VLLM_MAX_TOKENS?.trim() ?? 0) || 900);
  const messages: ChatMessage[] = [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: `Compile this controlled document.\n\n${doc}` },
  ];

  let lastErrors: string[] = [];
  for (let round = 0; round < 2; round++) {
    let res: ChatResult;
    try {
      res = await chat(messages, { json: true, maxTokens: budget, temperature: 0 });
    } catch (e) {
      return fallback(`served model failed: ${(e as Error).message}`);
    }
    acc.record(res);
    const value = parseBlock(res.text);
    if (!value) {
      lastErrors = ['the answer contained no parsable JSON object'];
      messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
      messages.push({ role: 'user', content: `That is not a parsable object. Return the complete corrected JSON only.\n\n${lastErrors.join('\n')}` });
      corrections++;
      continue;
    }
    const { procedure, dropped } = compileProcedure(value, resolveTwin(value));
    const report = inspectModel(procedure);
    if (report.ok) {
      return {
        result: { procedure, integrity: { ok: true, errors: [], notes: report.notes }, dropped, author: 'model', corrections },
        llm: acc.provenance(),
      };
    }
    // one round of correction with the validator's own words; the gate is the
    // contract, so complaining to the model about it is the cheapest fix available
    lastErrors = report.errors;
    if (round === 0) {
      messages.push({ role: 'assistant', content: res.text.slice(0, 4000) });
      messages.push({ role: 'user', content: `The integrity gate rejected this:\n${report.errors.map((e) => `- ${e}`).join('\n')}\n\nReturn the complete corrected JSON only. Do not add plant variable names.` });
      corrections++;
    }
  }

  return fallback(`model output still failed the gate: ${lastErrors.slice(0, 4).join('; ')}`);
}

function parseBlock(text: string): Record<string, unknown> | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  try {
    const v = JSON.parse(block) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A twin id the model did not know is a repairable omission, not a rejected document. */
function resolveTwin(raw: Record<string, unknown>): TwinDef {
  const named = str(raw.twin);
  try {
    return getTwin(named);
  } catch {
    return getTwin(/furnace|refractory|burner|light-off|fuel gas/i.test(JSON.stringify(raw).slice(0, 6000)) ? 'furnace_lightoff' : 'tank_transfer');
  }
}

/**
 * Rebuild the model from known fields only.
 *
 * Everything the model returns passes through here, so the object handed to the
 * engine is exactly the declared shape: no invented keys, no references to steps
 * that do not exist, no plant variable nobody named.
 */
export function compileProcedure(raw: Record<string, unknown>, twin: TwinDef): { procedure: Procedure; dropped: string[] } {
  const dropped: string[] = [];
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  const steps: Step[] = [];
  const used = new Set<string>();
  const usedErrors = new Set<string>();

  rawSteps.forEach((entry, i) => {
    const j = (entry ?? {}) as Record<string, unknown>;
    let id = str(j.id) || `d${i + 1}`;
    while (used.has(id)) id = `${id}_`;
    used.add(id);

    const text = str(j.text) || str(j.title) || `Step ${i + 1} of the document.`;
    const kind = KINDS.includes(j.kind as ActionKind) ? (j.kind as ActionKind) : inferKind(text);
    const cue = CUES.includes(j.cue as Step['cue']) ? (j.cue as Step['cue']) : inferCue(text);
    const title = str(j.title) || text.slice(0, 60);

    const step: Step = { id, title, text, role: str(j.role) || 'field operator', cue, kind, durS: int(j.durS, DEFAULT_DUR[kind]) };

    const sim = int(j.similarity, 0);
    if (sim > 1) step.similarity = sim;
    const gtt = str(j.gtt).toUpperCase();
    if (HEART_GTT[gtt]) step.gtt = gtt;

    const cond = (Array.isArray(j.cond) ? j.cond : []).filter((c): c is ConditionId => isValidCondition(String(c)));
    if (cond.length) step.cond = cond;
    for (const c of Array.isArray(j.cond) ? j.cond : []) {
      if (!isValidCondition(String(c))) dropped.push(`${id}: condition "${c}" is not in the catalogue`);
    }

    const applies = dropUnknownKeys(twin, j.applies, `${id} applies`, dropped);
    if (Object.keys(applies).length) step.applies = applies;

    const errors = compileErrors(j.errors, id, twin, dropped, usedErrors);
    if (errors.length) step.errors = errors;

    if (j.verify && typeof j.verify === 'object') {
      const v = j.verify as Record<string, unknown>;
      const of = (Array.isArray(v.of) ? v.of : []).map(str).filter((x) => used.has(x));
      const missing = (Array.isArray(v.of) ? v.of : []).map(str).filter((x) => !used.has(x));
      if (missing.length) dropped.push(`${id}: verifies unknown or later step ${missing.join(', ')}`);
      if (of.length) {
        step.verify = { of, via: CUES.includes(v.via as Step['cue']) ? (v.via as Step['cue']) : cue, kind: KINDS.includes(v.kind as ActionKind) ? (v.kind as ActionKind) : 'verify' };
        const vg = str(v.gtt).toUpperCase();
        if (HEART_GTT[vg]) step.verify.gtt = vg;
      }
    }

    if (j.watch && typeof j.watch === 'object') {
      const w = j.watch as Record<string, unknown>;
      const name = knownVar(twin, w.var);
      if (!name) dropped.push(`${id}: watch variable "${str(w.var)}" is not on ${twin.id}, watch dropped`);
      else {
        const at = typeof w.atLeast === 'number' ? w.atLeast : typeof w.atMost === 'number' ? w.atMost : NaN;
        const watch: NonNullable<Step['watch']> = { var: name, atLeast: Number.isFinite(at) ? at : undefined };
        const alt = w.alt && typeof w.alt === 'object' ? (w.alt as Record<string, unknown>) : undefined;
        const altName = alt ? knownVar(twin, alt.var) : null;
        if (alt && altName && typeof alt.atLeast === 'number') watch.alt = { var: altName, atLeast: alt.atLeast };
        const onHit = dropUnknownKeys(twin, w.onHit, `${id} watch onHit`, dropped);
        if (Object.keys(onHit).length) watch.onHit = onHit;
        if (int(w.maxWaitS, 0) > 0) watch.maxWaitS = int(w.maxWaitS, 0);
        if (int(w.lateMaxS, 0) > 0) watch.lateMaxS = int(w.lateMaxS, 0);
        step.watch = watch;
      }
    }

    if (j.until && typeof j.until === 'object') {
      const u = j.until as Record<string, unknown>;
      const name = knownVar(twin, u.var);
      if (name && typeof u.atLeast === 'number') step.until = { var: name, atLeast: u.atLeast };
      else dropped.push(`${id}: until reference "${str(u.var)}" is not on ${twin.id}`);
    }

    for (const key of ['guard', 'deadline'] as const) {
      const c = j[key];
      if (!c || typeof c !== 'object') continue;
      const g = c as Record<string, unknown>;
      const name = knownVar(twin, g.var);
      if (name && OPS.includes(g.op as (typeof OPS)[number]) && typeof g.value === 'number') step[key] = { var: name, op: g.op as NonNullable<Step['guard']>['op'], value: g.value };
      else dropped.push(`${id}: ${key} "${str(g.var)}" is not evaluable on ${twin.id}`);
    }

    if (j.emergency && typeof j.emergency === 'object') {
      const e = j.emergency as Record<string, unknown>;
      const onHit = dropUnknownKeys(twin, e.onHit, `${id} emergency onHit`, dropped);
      const maxResponseS = int(e.maxResponseS, 0);
      if (Object.keys(onHit).length && maxResponseS > 0) step.emergency = { maxResponseS, onHit };
      else dropped.push(`${id}: emergency action incomplete, dropped`);
    }

    if (j.xcheck === true) step.xcheck = true;
    steps.push(step);
  });

  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : []).flatMap((entry, i) => {
    const w = (entry ?? {}) as Record<string, unknown>;
    const label = str(w.label);
    const cond = String(w.cond ?? '');
    const stepRefs = (Array.isArray(w.steps) ? w.steps : []).map(str).filter((x) => used.has(x));
    if (!label || !isValidCondition(cond)) {
      dropped.push(`warning ${str(w.id) || i}: dropped, unknown condition or no label`);
      return [];
    }
    if (!stepRefs.length) {
      dropped.push(`warning ${str(w.id) || i}: names no step that exists`);
      return [];
    }
    return [{ id: str(w.id) || `W${i + 1}`, label, cond: cond as ConditionId, level: Math.min(3, Math.max(1, int(w.level, 1))), steps: stepRefs }];
  });

  const procedure: Procedure = {
    id: str(raw.id) || 'UNNUMBERED-000',
    title: str(raw.title) || 'Compiled procedure',
    twin: twin.id,
    revision: str(raw.revision) || '0',
    language: str(raw.language) || 'en',
    roles: (Array.isArray(raw.roles) ? raw.roles : []).map(str).filter(Boolean),
    summary: str(raw.summary),
    steps,
  };
  if (!procedure.roles.length) procedure.roles = ['field operator'];
  if (!procedure.summary) procedure.summary = procedure.title;
  if (warnings.length) procedure.warnings = warnings;

  return { procedure, dropped };
}

function compileErrors(raw: unknown, stepId: string, twin: TwinDef, dropped: string[], usedIds: Set<string>): ErrorAlternative[] {
  const out: ErrorAlternative[] = [];
  if (!Array.isArray(raw)) return out;
  raw.forEach((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const text = str(e.text);
    if (!text) {
      dropped.push(`${stepId}: error alternative ${str(e.id) || i} had no description`);
      return;
    }
    if (!ERROR_KINDS.includes(e.kind as ErrorKind)) {
      dropped.push(`${stepId}: error kind "${str(e.kind)}" is not one of ${ERROR_KINDS.join(', ')}`);
      return;
    }
    let id = str(e.id) || `${stepId}e${out.length + 1}`;
    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);
    const weight = typeof e.weight === 'number' && Number.isFinite(e.weight) ? Math.max(0, e.weight) : 25;
    const alt: ErrorAlternative = { id, kind: e.kind as ErrorKind, weight, text, patch: {}, source: SOURCES.includes(e.source as ErrorAlternative['source']) ? (e.source as ErrorAlternative['source']) : 'model' };
    const patch = dropUnknownKeys(twin, (e.patch as Record<string, unknown> | undefined)?.set, `${stepId}/${id} patch`, dropped);
    if (Object.keys(patch).length) alt.patch = { set: patch } satisfies DiscretePatch;
    if (e.alsoApplies === true) alt.alsoApplies = true;
    const symptom = str(e.symptom);
    if (symptom) alt.symptom = symptom;
    out.push(alt);
  });
  return out;
}

/* the deterministic compiler: same document, same answer, no GPU */

/**
 * Fallback compilation.
 *
 * It reads the printed numbering and the verbs, and nothing else, because that is
 * all a rule can honestly read. What it gives up is the error surface depth and
 * the shaping conditions - which is why the result says it came from the offline
 * path instead of dressing a skeleton up as an analysis.
 */
export function offlineParse(markdown: string): Omit<ParseResult, 'corrections'> {
  const twin = getTwin(/furnace|refractory|burner|light-off|fuel gas/i.test(markdown) ? 'furnace_lightoff' : 'tank_transfer');
  const numbered = [...markdown.matchAll(/^\s*(\d{1,3})[.)]\s+(.+)$/gm)];
  const items: { text: string; recover: boolean }[] = numbered.length
    ? numbered.map((m) => ({ text: m[2].replace(/\s+/g, ' ').trim(), recover: false }))
    : fallbackLines(markdown).map((t) => ({ text: t, recover: false }));

  // an "If something goes wrong" section is unnumbered in most real documents, and
  // a procedure compiled without its recovery action will overstate the hazard
  if (numbered.length) {
    for (const m of markdown.matchAll(/^\s*[-*]\s+(If\b[^\n]{19,})$/gm)) items.push({ text: m[1].replace(/\s+/g, ' ').trim(), recover: true });
  }

  let seq = 0;
  let rec = 0;
  const steps: Step[] = items.map((item) => {
    const kind: ActionKind = item.recover ? 'recover' : inferKind(item.text);
    const cue = inferCue(item.text);
    const clean = item.text.replace(/^\s*[-*]\s+/, '');
    const step: Step = {
      id: item.recover ? `e${++rec}` : `d${++seq}`,
      title: clean.split(/[.,;](?:\s|$)/)[0].slice(0, 72),
      text: clean,
      role: /control room/.test(clean) && !/call the control room/.test(clean) ? 'control room' : 'field operator',
      cue,
      kind,
      durS: DEFAULT_DUR[kind],
    };
    const cond: ConditionId[] = [];
    if (kind === 'monitor') cond.push('timing_critical');
    if (kind === 'recover') cond.push('unprepared_exception');
    if (cue === 'verbal') cond.push('teamwork');
    if (cue === 'memory') cond.push('memory_load');
    if (/if in doubt|approximately|if possible|as expected|if necessary/i.test(clean)) cond.push('ambiguous_wording');
    if (/isolation|returned to service|last \d+ days|bench test|instrument work/i.test(clean)) cond.push('post_maintenance_state');
    if (cond.length) step.cond = cond;

    if (item.recover && (twin.discIndex(twin.iface.stopFlag) >= 0 || twin.varIndex(twin.iface.stopFlag) >= 0)) {
      step.emergency = { maxResponseS: 120, onHit: { [twin.iface.stopFlag]: 1, [twin.iface.runFlag]: 0 } };
    }

    const errors = offlineSurface(kind, cue, step).map((alt, n) => ({ ...alt, id: `${step.id}e${n + 1}` }));
    if (errors.length) step.errors = errors;
    return step;
  });

  const heading = /^\s*#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  const procedure: Procedure = {
    id: /\*\*Document:\*\*\s*([A-Z0-9-]+)/.exec(markdown)?.[1] ?? 'UNNUMBERED-000',
    title: heading ?? 'Compiled procedure',
    twin: twin.id,
    revision: /\*\*Revision:\*\*\s*([A-Za-z0-9.-]+)/.exec(markdown)?.[1] ?? '0',
    language: 'en',
    roles: ['field operator'],
    summary: steps.map((s) => s.title).slice(0, 3).join('; '),
    steps,
  };
  if (/\bcontrol room\b/.test(markdown)) procedure.roles.push('control room');

  const report = inspectModel(procedure);
  return {
    procedure,
    integrity: { ok: report.ok, errors: report.errors, notes: [...report.notes, 'compiled by the offline rule: no watch criteria, no plant patch, timing from the action table'] },
    dropped: [],
    author: 'offline',
  };
}

/**
 * The rule-generated error surface.
 *
 * Kinds are chosen from what the action type makes possible; the weights are the
 * flat prior an analyst starts from before any data. It is deliberately blunt -
 * a skeleton that reads like research is worse than no surface at all.
 */
function offlineSurface(kind: ActionKind, cue: Step['cue'], step: Step): Omit<ErrorAlternative, 'id'>[] {
  const at = (k: ErrorKind, w: number, t: string): Omit<ErrorAlternative, 'id'> => ({ kind: k, weight: w, text: t, patch: {}, source: 'analyst' });
  const done = `The crew acts on the state it believes the previous ${step.role} left, not on the state in front of it.`;
  switch (kind) {
    case 'actuate':
      return [
        at('omission', 35, `Not done at all: "${step.title}" is assumed already correct from the last job.`),
        cue === 'label' ? at('wrong_target', 40, done) : at('wrong_direction', 35, 'The device is moved the wrong way and the movement reads as the intended one.'),
        at('incomplete', 25, 'Moved, but not through to the stop, and nothing at the handle shows how far it went.'),
      ];
    case 'verify':
      return [
        at('omission', 55, `Skipped: there is no artefact that proves "${step.title}" was done, so it is done in the head.`),
        at('misread', 45, done),
      ];
    case 'monitor':
      return [
        at('delayed_response', 55, 'The criterion is seen late: the crew was elsewhere when the number crossed, and the walk back is not instant.'),
        at('omission', 45, 'The watch is handed to nobody. The transfer runs while the crew does the next job.'),
      ];
    case 'communicate':
      return [
        at('omission', 50, 'Written up after the shift from memory, so the record describes what was intended.'),
        at('misread', 50, 'The value is transcribed as read, including whatever the instrument is wrong by.'),
      ];
    case 'authorise':
      return [
        at('omission', 60, 'Started on the strength of the previous job rather than a document for this one.'),
        at('misread', 40, 'The paper is valid but names a different piece of plant, and nobody compares the tag.'),
      ];
    case 'recover':
      return [at('delayed_response', 100, 'The abnormal condition is not believed quickly enough, so the response starts late.')];
    default:
      return [];
  }
}

/** Last resort when a document has no numbering at all: the imperative sentences. */
function fallbackLines(markdown: string): string[] {
  const lines = markdown
    .split('\n')
    .map((l) => l.replace(/[#*>`_-]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 24 && /^(open|close|confirm|check|start|stop|record|walk|enter|hold|obtain|drain|if|call|update|the )/i.test(l));
  return lines.length ? lines.slice(0, 40) : ['Confirm the plant is in the state the document assumes before energy is introduced.'];
}

/* ------------------------------------------------ b) scenario author (human factors) */

export interface ScenarioResult {
  stepId: string;
  kind: ErrorKind;
  twin: string;
  text: string;
  symptom?: string;
  /** variable names the model claims the mistake touches, filtered against the twin */
  patchKeys: string[];
  /** the executable part: only keys whose adverse state is documented or demanded by the step */
  patch: DiscretePatch;
  /** names that survive validation but need an analyst to give them a value */
  unresolved: string[];
  source: 'model' | 'offline';
}

const SCENARIO_SYSTEM = `You are a human-factors specialist preparing error modes for a procedural reliability study. You have walked transfer racks and furnace decks and you know what a competent crew actually does wrong; you are not writing a taxonomy.

Given one step of one procedure, one typed error kind, the crew and the plant configuration, write how that specific mistake happens on that specific site and what the person would notice at the time.

Output JSON:
{"text":"2-4 sentences, present or past tense as an account of the crew, naming the device, the reading or the paperwork that misleads them","symptom":"what the operator perceives, or 'nothing' if the deviation is silent","patchKeys":["variable names from the given list that this mistake actually changes"]}

Rules:
1. patchKeys only from the list you are given. A name not on it means your scenario cannot be simulated, and the run will silently ignore it.
2. Text is the mechanism, not the label. Never restate the error kind, never write "the operator makes an error". Say what they did, why it seemed right at the time, and what about the plant or the paperwork let it seem right.
3. Ground it in the crew and the configuration you are given: years on the job, hours into the shift, what is isolated, what the indicator is wrong by, what else they were told to do at the same time.
4. The crew is not stupid and not negligent. The best accounts describe a rational action that the plant cannot distinguish from a wrong one.
5. Do not state a consequence in the physics you have not been given. If nothing observable changes, symptom is "nothing".`;

/**
 * Which state makes a named flag unsafe.
 *
 * Values are analyst policy. A model that returns a variable name has told us
 * where the mistake lands; it has not earned the right to set the magnitude, and
 * an invented number in the twin is the exact fiction the integrity gate exists
 * to stop. Anything not covered here is returned as `unresolved` for an analyst.
 */
const ADVERSE: Record<string, number> = {
  LAH: 0, PIS: 0, PISFAIL: 1, RACK: 0, BOND_OK: 0, V4: 0, V3LEAK: 1, HAMMER: 1, HOSE_SPILL: 1, BUND_HEADROOM: 0,
  FAN: 0, DAMPER: 0, PILOT: 0, BMS: 0, BMSFAIL: 1, GASLEAK: 1, INTERLOCKED: 0,
};

/** Conditions the analyst associates with plant state, so the offline surface is at least about this tank. */
const CONDITION_KEYS: Partial<Record<ConditionId, string[]>> = {
  post_maintenance_state: ['PIS', 'LAH'],
  incomplete_function_test: ['PISFAIL'],
  absent_cue: ['gaugeBias'],
  mistrust: ['gaugeBias'],
};

export async function writeErrorScenario(step: Step, persona: PersonaTraits, plant: PlantConfig, kind?: ErrorKind): Promise<AgentOutcome<ScenarioResult>> {
  const acc = new Accounting();
  // the twin is a property of the configuration under test, never of the step:
  // a scenario about a furnace cannot be instantiated against a tank
  const twin = safeTwin(plant.twin);
  const chosen = normaliseKind(kind ?? step.errors?.[0]?.kind ?? 'omission', step);
  const gate = await availability();
  if (!gate.ok) {
    return { result: offlineScenario(step, persona, plant, chosen, twin), llm: acc.provenance(`offline path: ${gate.reason}`) };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SCENARIO_SYSTEM },
    {
      role: 'user',
      content: [
        `Twin: ${twin.id} (${twin.label}, ${twin.unit}); hazard of concern: ${twin.hazardKind}.`,
        `Variable names you may use: ${[...twin.discs, ...twin.vars].join(', ')}`,
        `Error kind to realise: ${chosen}`,
        `Step ${step.id}: ${step.title}. Text: "${step.text}" Role ${step.role}, cue ${step.cue}, action ${step.kind}, nominal ${step.durS}s${step.similarity ? `, ${step.similarity} near-identical devices` : ''}${step.cond?.length ? `, conditions ${step.cond.join(', ')}` : ''}${step.applies && Object.keys(step.applies).length ? `, intended plant change ${JSON.stringify(step.applies)}` : ', intended plant change not stated'}`,
        `Crew: ${persona.label}; ${persona.experienceY} years, ${persona.runsBefore} previous runs, ${persona.hoursIntoShift}h into a shift starting ${persona.shiftStartHour}:00, language friction ${persona.languageFriction}, ${persona.concurrency} concurrent job(s), deadline pressure ${persona.deadlinePressure}, qualification ${persona.qualificationCurrent ? 'current' : 'not current'}, team readiness ${persona.teamReadiness}.`,
        `Plant: ${plant.label}; protections ${JSON.stringify(plant.protection)}; protective devices ${plant.provenRecent ? 'proved inside interval' : 'not proved'}${plant.preIsolated?.length ? `; isolated at start: ${plant.preIsolated.join(', ')}` : ''}${plant.instrumentDrift && Object.keys(plant.instrumentDrift).length ? `; indicator error ${JSON.stringify(plant.instrumentDrift)}` : ''}. ${plant.notes ?? ''}`,
      ].join('\n'),
    },
  ];

  try {
    const res = await chat(messages, { json: true, maxTokens: Math.max(500, Number(process.env.AMD_VLLM_MAX_TOKENS?.trim() ?? 0) || 900), temperature: 0.4 });
    acc.record(res);
    const value = parseBlock(res.text);
    const text = str(value?.text);
    if (!value || !text) throw new Error('no scenario text in the answer');
    const claimed = Array.isArray(value.patchKeys) ? value.patchKeys.map(String) : [];
    const patchKeys = [...new Set(claimed.filter((k) => twin.discIndex(k) >= 0 || twin.varIndex(k) >= 0))];
    const rejected = [...new Set(claimed.filter((k) => twin.discIndex(k) < 0 && twin.varIndex(k) < 0))];
    const { set, unresolved } = adverseState(twin, step, chosen, patchKeys);
    const symptom = str(value.symptom);
    return {
      result: {
        stepId: step.id, kind: chosen, twin: twin.id, text,
        symptom: symptom || undefined, patchKeys, patch: Object.keys(set).length ? { set } : {}, unresolved,
        source: 'model',
      },
      // the invented names are kept in the provenance: rejecting a scenario
      // silently is how a model learns to invent quietly
      llm: acc.provenance(rejected.length ? `rejected ${rejected.length} variable name(s) not on ${twin.id}: ${rejected.join(', ')}` : undefined),
    };
  } catch (e) {
    return { result: offlineScenario(step, persona, plant, chosen, twin), llm: acc.decline(`offline path: ${(e as Error).message}`) };
  }
}

function normaliseKind(kind: ErrorKind, step: Step): ErrorKind {
  if (!ERROR_KINDS.includes(kind)) return 'omission';
  // a direction or target mistake cannot happen on a step with nothing to move
  if ((kind === 'wrong_direction' || kind === 'wrong_target') && !step.applies && step.kind !== 'actuate') return 'commission';
  return kind;
}

function safeTwin(id: string | undefined): TwinDef {
  try {
    return getTwin(id ?? 'tank_transfer');
  } catch {
    return getTwin('tank_transfer');
  }
}

function adverseState(twin: TwinDef, step: Step, kind: ErrorKind, keys: string[]): { set: Record<string, number>; unresolved: string[] } {
  const set: Record<string, number> = {};
  const unresolved: string[] = [];
  const active = kind === 'commission' || kind === 'wrong_target' || kind === 'wrong_direction' || kind === 'premature' || kind === 'out_of_sequence';
  for (const k of keys) {
    if (step.applies && Object.prototype.hasOwnProperty.call(step.applies, k)) {
      const intent = step.applies[k];
      if (intent === 0 || intent === 1) set[k] = intent === 1 ? 0 : 1;
      else unresolved.push(k);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(ADVERSE, k)) {
      set[k] = ADVERSE[k];
      continue;
    }
    if (twin.discIndex(k) >= 0 && active) {
      set[k] = 1;
      continue;
    }
    // a continuous process quantity needs a magnitude nobody has authored yet
    unresolved.push(k);
  }
  return { set, unresolved };
}

function offlineScenario(step: Step, persona: PersonaTraits, plant: PlantConfig, kind: ErrorKind, twin: TwinDef): ScenarioResult {
  const why = persona.experienceY < 2
    ? `on ${persona.runsBefore} previous runs of this procedure`
    : `${persona.experienceY} years on the plant and this transfer is routine`;
  const when = persona.shiftStartHour >= 22 || persona.shiftStartHour < 5 ? 'night shift' : 'day shift';
  const rush = persona.deadlinePressure > 0.4 ? ' with a vehicle turnaround to make' : '';
  const iso = plant.preIsolated?.length ? ` The permits left ${plant.preIsolated.join(', ')} isolated at handover.` : '';
  const drift = plant.instrumentDrift && Object.keys(plant.instrumentDrift).length ? ` The local indication is out by ${JSON.stringify(plant.instrumentDrift)}.` : '';

  const keys = new Set<string>();
  for (const k of Object.keys(step.applies ?? {})) {
    if (kind === 'omission' || kind === 'incomplete' || kind === 'delayed_response' || kind === 'misread') keys.add(k);
  }
  for (const c of step.cond ?? []) for (const k of CONDITION_KEYS[c] ?? []) if (twin.discIndex(k) >= 0 || twin.varIndex(k) >= 0) keys.add(k);
  if (kind === 'premature' || kind === 'out_of_sequence') keys.add(twin.iface.stopFlag);
  const list = [...keys];
  const { set, unresolved } = adverseState(twin, step, kind, list);

  const narration: Record<ErrorKind, string> = {
    omission: `"${step.title}" is not performed. ${step.cue === 'memory' || step.cue === 'label' ? 'The crew acts on the configuration it expects from the last job rather than the one standing in front of it.' : 'Nothing downstream asks for it, so nothing returns a proof.'} ${when} ${why}${rush}.`,
    commission: `Something is done that the document does not ask for, on ${step.id}, and it looks like progress: ${step.cue === 'label' ? 'the adjacent identical device answers to the same reasoning.' : 'the state reached is the state the crew expected to see.'} ${when}${rush}.`,
    wrong_target: `${step.similarity ?? 2} devices that read the same way are on one manifold. The crew moves the neighbour and the check that would have caught it is a ${step.cue} cue that is not where the handle is.${drift}`,
    wrong_direction: `The movement is made the other way. The ${step.cue} cue available at the device - a stem, a handwheel height, a plate - reads the same for both, so the walk-back confirms the mistake rather than the correction.`,
    out_of_sequence: `The action is taken before the one that makes it safe. ${iso} The document orders these steps but nothing at the plant enforces the order, and on a ${when} shift with ${persona.concurrency} job(s) in hand the order is the part that gets lost.`,
    incomplete: `Started and stopped part way: "${step.title}" is satisfied by the first sign of movement. ${step.cue === 'physical' ? 'There is no positive indication at the device of having gone through to the stop.' : 'The record does not distinguish done from nearly done.'}${drift}`,
    premature: `The step is taken while the condition it depends on is still moving. Nothing tells the crew to wait, and ${rush ? 'the schedule says not to wait' : 'nobody has written a hold point'}.`,
    delayed_response: `The criterion is reached and seen, and the action comes ${Math.round(step.durS / 2) + 30}s late: the crew is ${persona.concurrency > 1 ? 'finishing another job before coming back' : 'still reading the indication'}, and the walk to the ${twin.iface.runFlag.toLowerCase()} handle is not in the timing of the document.`,
    misread: `The reading taken is not the quantity asked for.${drift || ' The indication available is the neighbour of the one that matters, or is wrong by an offset nobody has written down.'} On a ${when} shift, ${why}, the difference is not visible from where the crew stands.`,
  };

  return {
    stepId: step.id, kind, twin: twin.id,
    text: narration[kind],
    symptom: kind === 'misread' || kind === 'delayed_response' ? 'nothing until the process itself disagrees' : 'nothing at the device',
    patchKeys: list,
    patch: Object.keys(set).length ? { set } : {},
    unresolved,
    source: 'offline',
  };
}

/* ------------------------------------------------------- c) adversarial review */

export interface Finding {
  id: string;
  procedureId: string;
  revision?: string;
  method: HraMethod;
  step: Step;
  error?: ErrorAlternative;
  kind: ErrorKind;
  /** the HEP derivation itself; a review of the prose alone is not a review */
  hep: {
    p: number;
    nominal: number;
    multiplier: number;
    lo: number;
    hi: number;
    basis: string;
    adjusted: boolean;
    rows: { id: string; label: string; level: string; mult: number; why: string }[];
    suppressed?: { psf: string; level: string; why: string }[];
  };
  conditions?: ConditionId[];
  stats?: { reached: number; thrown: number; caught: number; escaped: number; causal: number; n: number };
  persona?: string;
  plant?: string;
  outcome?: string;
}

export interface ReviewVerdict {
  findingId: string;
  verdict: 'retain' | 'drop' | 'revise';
  confidence: number;
  reason: string;
  revision?: string;
}

const REVIEW_SYSTEM = `You are a probabilistic safety assessment reviewer. Your job on this task is one-sided: argue that the finding is NOT credible. You are paid to be the person in the meeting who says the sequence does not work, and you must not soften it into "reasonable, but".

Check, in this order, and cite the numbers you are given:
1. Sequence: does the described deviation survive the checks, indications and protective functions that come after it in the same procedure? If a later step verifies it, the finding needs a second failure it has not accounted for.
2. Cue availability: is the information the crew is claimed to have missed actually present at the point of action, on the right device, readable from where they stand? "Absent cue" and "misread" contradict each other.
3. Blocked by design: does an interlock, a keyed device, an independent trip or a configuration the plant already carries make this mode unreachable? Then it is not a finding, it is a hypothesis about a different plant.
4. Probability consistency: the published rows in the HEP derivation are the arithmetic. If the reported probability does not follow from the nominal rate and the multipliers, or sits outside the order-of-magnitude band the method itself declares, the number is not defensible whatever the story says.
5. Shaping factors: are the conditions driving the rate consistent with the crew and configuration named in the finding? A finding about an expert day-shift operator cannot be driven by "no procedure available".

Output JSON:
{"verdict":"retain|drop|revise","confidence":0.0-1.0,"reason":"the strongest single argument, with the numbers it rests on","revision":"for revise: what has to change for the finding to stand, one or two sentences"}

Use "drop" when the finding does not survive one of checks 1-3 or the arithmetic is wrong by more than the method's own band. Use "revise" when it is real but overstated. Default to "retain" only when you have looked for the reasons above and could not find one; a retain with no argument is a rubber stamp.`;

export async function reviewFinding(finding: Finding): Promise<AgentOutcome<ReviewVerdict>> {
  const acc = new Accounting();
  const gate = await availability();
  if (!gate.ok) return { result: ruleReview(finding), llm: acc.provenance(`offline path: ${gate.reason}`) };

  const messages: ChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM },
    { role: 'user', content: renderFinding(finding) },
  ];
  try {
    const res = await chat(messages, { json: true, maxTokens: 600, temperature: 0 });
    acc.record(res);
    const value = parseBlock(res.text);
    const verdict = str(value?.verdict);
    if (!value || (verdict !== 'retain' && verdict !== 'drop' && verdict !== 'revise')) throw new Error('no usable verdict in the answer');
    const confidence = typeof value.confidence === 'number' ? Math.min(1, Math.max(0, value.confidence)) : 0.5;
    const reason = str(value.reason) || 'the reviewer gave no reason';
    const revision = str(value.revision);
    return {
      result: { findingId: finding.id, verdict, confidence, reason, revision: verdict === 'revise' && revision ? revision : undefined },
      llm: acc.provenance(),
    };
  } catch (e) {
    return { result: ruleReview(finding), llm: acc.decline(`offline path: ${(e as Error).message}`) };
  }
}

export async function reviewFindings(findings: Finding[]): Promise<AgentOutcome<{ verdicts: ReviewVerdict[]; reviewed: number }>> {
  const verdicts: ReviewVerdict[] = [];
  let used = 0;
  let prompt = 0;
  let completion = 0;
  let latency = 0;
  let model: string | undefined;
  let endpoint: string | undefined;
  let reason: string | undefined;

  // sequential on purpose: one served model on one GPU is a single lane, and
  // fanning four reviews at it makes every latency number in the panel a lie
  for (const f of findings) {
    const { result, llm } = await reviewFinding(f);
    verdicts.push(result);
    if (llm.used && llm.tokens) {
      used++;
      prompt += llm.tokens.prompt;
      completion += llm.tokens.completion;
      latency += llm.latencyMs ?? 0;
      model = llm.model;
      endpoint = llm.endpoint;
    } else if (llm.reason) {
      reason = llm.reason;
    }
  }

  const llm: LlmProvenance = used
    ? { used: true, model, endpoint, tokens: { prompt, completion }, latencyMs: latency, calls: used }
    : { used: false, reason: reason ?? 'offline path' };
  return { result: { verdicts, reviewed: verdicts.length }, llm };
}

/** One render of the derivation, so the reviewer is shown the arithmetic and not a summary of it. */
function renderFinding(f: Finding): string {
  const h = f.hep;
  const rows = h.rows.map((r) => `  ${r.id} ${r.label}: ${r.level} x${r.mult} (${r.why})`).join('\n');
  const sup = (h.suppressed ?? []).map((s) => `  ${s.psf} held at nominal: ${s.why}`).join('\n');
  const seq = f.step.verify ? `this step is checked by ${f.step.verify.of.join(', ')} via ${f.step.verify.via}` : 'no verification attached to this step';
  return [
    `Method ${f.method}, procedure ${f.procedureId}${f.revision ? ` rev ${f.revision}` : ''}, step ${f.step.id} (${f.step.kind}, ${f.step.cue} cue, ${f.step.durS}s).`,
    `Step text: "${f.step.text}"`,
    f.step.errors?.length ? `Error surface of this step: ${f.step.errors.map((e) => `${e.id}/${e.kind}/${e.weight}`).join(', ')}` : 'Error surface: only the one alternative under review.',
    `Finding ${f.id}, kind ${f.kind}: "${f.error?.text ?? f.step.text}"${f.error?.symptom ? ` Symptom claimed: ${f.error.symptom}` : ''}`,
    f.stats ? `Observed in the run: reached ${f.stats.reached}/${f.stats.n}, thrown ${f.stats.thrown}, caught ${f.stats.caught}, survived ${f.stats.escaped}, first-causal ${f.stats.causal}.` : 'No batch statistics supplied.',
    f.conditions?.length ? `Active conditions: ${f.conditions.join(', ')}` : 'No active conditions recorded.',
    f.persona ? `Crew: ${f.persona}` : 'Crew: not stated.',
    f.plant ? `Configuration: ${f.plant}` : 'Configuration: not stated.',
    f.outcome ? `Outcome reached: ${f.outcome}` : '',
    `HEP derivation (p=${h.p.toExponential(2)}, nominal=${h.nominal.toExponential(2)}, product of rows=${h.multiplier.toExponential(2)}, band ${h.lo.toExponential(2)} to ${h.hi.toExponential(2)}${h.adjusted ? ', SPAR-H adjustment applied' : ''}):\n${rows}${sup ? `\nSuppressed:\n${sup}` : ''}\nBasis: ${h.basis}`,
    `Sequence notes: ${seq}${f.step.xcheck ? '; carries an independent verification' : ''}${f.step.applies?.INTERLOCKED ? '; the device is interlocked in this variant' : ''}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The rule-based reviewer.
 *
 * It is a real check rather than a neutral stand-in: it recomputes the
 * probability from the same rows the finding was scored with, and it drops the
 * modes a forced control or an unreadable cue make unreachable. It will not
 * invent a narrative objection, which is the honest limit of a rule.
 */
export function ruleReview(f: Finding): ReviewVerdict {
  const h = f.hep;
  const objections: string[] = [];
  let verdict: ReviewVerdict['verdict'] = 'retain';
  let revision: string | undefined;

  if (f.step.applies?.INTERLOCKED === 1 && (f.kind === 'wrong_target' || f.kind === 'wrong_direction' || f.kind === 'out_of_sequence')) {
    return { findingId: f.id, verdict: 'drop', confidence: 0.8, reason: `The step is carried with an interlock in this variant, so a ${f.kind} on the device is blocked by the control rather than made less likely. This is a finding about a plant without that interlock.` };
  }
  if (f.stats && f.stats.reached === 0) {
    return { findingId: f.id, verdict: 'drop', confidence: 0.75, reason: 'The step is never reached in the batch, so the mode cannot contribute to the rate it is being quoted in.' };
  }

  let product = 1;
  for (const r of h.rows) if (Number.isFinite(r.mult)) product *= r.mult;
  const plain = h.nominal * product;
  const adjusted = h.nominal > 0 && product > 1 ? (h.nominal * product) / (1 + h.nominal * (product - 1)) : plain;
  const closer = Math.min(Math.abs(Math.log10(h.p / plain)), Math.abs(Math.log10(h.p / adjusted)));
  if (!Number.isFinite(closer) || closer > 0.6) {
    verdict = 'revise';
    objections.push(`the derivation gives ${adjusted.toExponential(2)} from nominal ${h.nominal.toExponential(2)} and a row product of ${product.toExponential(2)}, but the finding is quoted at ${h.p.toExponential(2)}`);
    revision = `Re-score ${f.id} against the published rows, or state which row was changed and by what condition.`;
  }
  if (h.p < h.lo || h.p > h.hi) {
    verdict = 'revise';
    objections.push(`p=${h.p.toExponential(2)} sits outside the ${f.method} band the method itself declares (${h.lo.toExponential(2)} to ${h.hi.toExponential(2)})`);
    revision = revision ?? `Keep the rate inside the ${f.method} order-of-magnitude band, or present it as a bounding case.`;
  }

  if (f.kind === 'misread' && f.step.cue === 'gauge' && !(f.conditions ?? []).some((c) => c === 'absent_cue' || c === 'mistrust' || c === 'incomplete_function_test')) {
    objections.push('the crew is claimed to misread a gauge while the configuration leaves it in service, undrifted and not discounted');
    if (verdict === 'retain') verdict = 'revise';
    revision = revision ?? 'Name the condition that makes the indication unreliable, or move the finding to the step where the cue genuinely is not there.';
  }
  if (f.kind === 'omission' && f.step.verify && f.stats && f.stats.caught > 0 && f.stats.escaped / Math.max(1, f.stats.thrown) < 0.05) {
    objections.push(`the deviation from this step is caught ${(f.stats.caught / Math.max(1, f.stats.thrown) * 100).toFixed(0)}% of the time by a later verification, so the finding cannot be quoted as an uncaught failure`);
    if (verdict === 'retain') verdict = 'revise';
    revision = revision ?? 'Quote the surviving rate after the verification that the procedure already carries, not the rate at which the step is skipped.';
  }

  if (!objections.length) {
    const exposure = f.stats && f.stats.n ? f.stats.escaped / f.stats.n : undefined;
    return {
      findingId: f.id,
      verdict: 'retain',
      confidence: exposure !== undefined && exposure > 0.005 ? 0.7 : 0.5,
      reason: `Looked for the standard objections and could not sustain one: the cue at ${f.step.id} is a ${f.step.cue} cue, the derivation product ${product.toExponential(2)} reproduces p=${h.p.toExponential(2)}, and ${f.stats ? `${f.stats.escaped} of ${f.stats.thrown} thrown deviations survive` : 'no batch evidence contradicts it'}.`,
    };
  }
  return { findingId: f.id, verdict, confidence: 0.6, reason: `Not credible as written: ${objections.join('; ')}.`, revision };
}

/* ------------------------------------------------------------ d) change order */

export interface RepairLoopResult {
  procedureId?: string;
  revision?: string;
  /** the configuration the loop was run on, for the header of the order */
  config?: { persona?: string; plant?: string; method?: HraMethod; seed?: string; shifts?: number };
  baseline: SummaryDto;
  stacked: { summary: SummaryDto; verdict: VariantVerdict | null; controls: string[] } | null;
  trials: CandidateTrial[];
}

export interface ChangeOrderFacts {
  order: string;
  procedureId: string;
  from: string;
  to: string;
  shifts: number;
  method: string;
  controls: { id: string; label: string; tier: string; describe: string; annualCostEur: number; addedSeconds: number; targets: string[] }[];
  failureBasePct: string;
  failureNewPct: string;
  deltaPts: string;
  ciPts: string;
  riskPct: string;
  iterations: number;
  annualLossBaseEur: string;
  annualLossNewEur: string;
  annualGainEur: string;
  controlCostEur: string;
  netEur: string;
  hazardDeltaS: string;
  nearMissBasePct: string;
  nearMissNewPct: string;
  releaseBaseM3: string;
  releaseNewM3: string;
  addedSeconds: number;
  rejected: { id: string; why: string }[];
}

export interface ChangeOrderResult {
  markdown: string;
  facts: ChangeOrderFacts;
  /** numeric literals the model emitted that appear nowhere in the evidence */
  scrubbed: string[];
  author: 'model' | 'offline';
}

const CHANGE_ORDER_SYSTEM = `You are a process-safety writer drafting a management-of-change order for an operating procedure. Your reader is a plant manager and an operations superintendent who will both argue with it, and a shift crew who have to perform it.

You will be given a fixed list of named values and the sections to write. You may refer to a figure ONLY as its placeholder token, written exactly like {{delta_pts}}. You must not type a number yourself, including dates, counts, percentages, currency or step numbers: your answer is scanned and any figure not present in the evidence is deleted before the order is issued, and the deletion is recorded against your name.

Write JSON:
{"scope":"what the change covers and what it does not","whatChanged":"how the revised procedure differs from the one in force, in the words a field operator would recognise","rationale":"why the mechanism works, in terms of the control tier and the failure path it removes","tested":"how the comparison was run, referring to {{shifts}} and {{method}} by token","rejected":"what was measured and did not earn its place, and why","residualRisk":"what can still go wrong after the change, and what the remaining exposure is","verification":"how the plant proves the change is in force and who signs it"}

Keep it plain and short. No adjectives about how important safety is. Never promise an outcome the evidence does not carry: an effect that failed the significance test is not a saving, and you are writing the order that goes in the file.`;

export function changeOrderFacts(loop: RepairLoopResult): ChangeOrderFacts {
  const base = loop.baseline;
  const stacked = loop.stacked;
  const s = stacked?.summary;
  const v = stacked?.verdict;
  const pct = (x: number) => `${(x * 100).toFixed(2)}`;
  const eur = (x: number) => Math.round(x).toLocaleString('en-US');
  const controls = (stacked?.controls ?? []).flatMap((id) => {
    const iv = interventionById(id);
    const trial = loop.trials.find((t) => t.control.id === id);
    if (!iv) return [];
    return [{ id, label: iv.label, tier: iv.tier, describe: iv.describe, annualCostEur: iv.effect.annualCostEur ?? 0, addedSeconds: iv.effect.addedSeconds ?? 0, targets: trial?.targets ?? [] }];
  });
  const rejected = loop.trials
    .filter((t) => !controls.some((c) => c.id === t.control.id))
    .map((t) => ({ id: t.control.id, why: t.error ?? t.verdict?.reasons[0] ?? 'no measurable effect inside the confidence interval' }));

  const deltaPts = s && base ? pct(s.failureRate - base.failureRate) : '0.00';
  return {
    order: `MOC-${loop.procedureId ?? 'UNNUMBERED'}-${(stacked?.controls ?? []).join('.') || 'none'}`,
    procedureId: loop.procedureId ?? base.variantId.split('/')[0],
    from: loop.revision ?? base.variantId,
    to: s?.variantId ?? base.variantId,
    shifts: Math.min(base.n, s?.n ?? base.n),
    method: loop.config?.method ?? 'sparh',
    controls,
    failureBasePct: base ? pct(base.failureRate) : '0.00',
    failureNewPct: s ? pct(s.failureRate) : pct(base.failureRate),
    deltaPts,
    ciPts: v ? `${pct(v.failure.ciLow)} to ${pct(v.failure.ciHigh)}` : 'not measured',
    riskPct: v ? (v.failure.oneSidedRisk * 100).toFixed(2) : '100',
    iterations: v?.failure.iterations ?? 0,
    annualLossBaseEur: base ? eur(base.annualLossEur) : '0',
    annualLossNewEur: s ? eur(s.annualLossEur) : '0',
    annualGainEur: v ? eur(v.annualGainEur) : '0',
    controlCostEur: eur(controls.reduce((a, b) => a + b.annualCostEur, 0)),
    netEur: v ? eur(v.netEur) : '0',
    hazardDeltaS: s && base ? (s.meanHazardS - base.meanHazardS).toFixed(1) : '0.0',
    nearMissBasePct: base ? pct(base.nearMissRate) : '0.00',
    nearMissNewPct: s ? pct(s.nearMissRate) : '0.00',
    releaseBaseM3: base ? base.meanReleaseM3.toFixed(3) : '0',
    releaseNewM3: s ? s.meanReleaseM3.toFixed(3) : '0',
    addedSeconds: controls.reduce((a, b) => a + b.addedSeconds, 0),
    rejected,
  };
}

/** Named tokens the model is allowed to use, and the only source of figures in the order. */
function factTokens(f: ChangeOrderFacts): Record<string, string> {
  return {
    procedure_id: f.procedureId, order: f.order, from_revision: f.from, to_revision: f.to,
    shifts: String(f.shifts), method: f.method,
    failure_base_pct: f.failureBasePct, failure_new_pct: f.failureNewPct, delta_pts: f.deltaPts,
    ci_pts: f.ciPts, risk_pct: f.riskPct, iterations: String(f.iterations),
    annual_loss_base_eur: f.annualLossBaseEur, annual_loss_new_eur: f.annualLossNewEur,
    annual_gain_eur: f.annualGainEur, control_cost_eur: f.controlCostEur, net_eur: f.netEur,
    hazard_delta_s: f.hazardDeltaS, near_miss_base_pct: f.nearMissBasePct, near_miss_new_pct: f.nearMissNewPct,
    release_base_m3: f.releaseBaseM3, release_new_m3: f.releaseNewM3, added_seconds: String(f.addedSeconds),
    controls: f.controls.map((c) => c.label).join('; ') || 'none',
    control_tiers: f.controls.map((c) => c.tier).join(', ') || 'none',
  };
}

export async function draftChangeOrder(loop: RepairLoopResult): Promise<AgentOutcome<ChangeOrderResult>> {
  const acc = new Accounting();
  const facts = changeOrderFacts(loop);
  const tokens = factTokens(facts);
  const gate = await availability();
  if (!gate.ok) {
    return {
      result: { markdown: renderOrder(facts, offlineNarrative(facts)), scrubbed: [], facts, author: 'offline' },
      llm: acc.provenance(`offline path: ${gate.reason}`),
    };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: CHANGE_ORDER_SYSTEM },
    {
      role: 'user',
      content: [
        `Named values you may refer to, by token only:\n${Object.entries(tokens).map(([k, v]) => `  {{${k}}} = ${v}`).join('\n')}`,
        `Controls adopted:\n${facts.controls.map((c) => `  - ${c.label} (${c.tier}); ${c.describe}; acts on ${c.targets.join(', ') || 'the configuration'}`).join('\n') || '  none'}`,
        `Measured and rejected:\n${facts.rejected.map((r) => `  - ${r.id}: ${r.why}`).join('\n') || '  none'}`,
        `Baseline variant ${facts.from}; revised variant ${facts.to}; ${facts.shifts} paired shifts per arm, method ${facts.method}.`,
        'Write the JSON object described in the instructions.',
      ].join('\n'),
    },
  ];

  try {
    const res = await chat(messages, { json: true, maxTokens: 1200, temperature: 0.3 });
    acc.record(res);
    const value = parseBlock(res.text);
    if (!value || !str(value.whatChanged)) throw new Error('no narrative in the answer');
    const scrubbed: string[] = [];
    const narrative: Record<string, string> = {};
    for (const key of ['scope', 'whatChanged', 'rationale', 'tested', 'rejected', 'residualRisk', 'verification'] as const) {
      narrative[key] = scrub(str(value[key]), tokens, scrubbed, key);
    }
    return { result: { markdown: renderOrder(facts, narrative, scrubbed), facts, scrubbed, author: 'model' }, llm: acc.provenance(scrubbed.length ? `removed ${scrubbed.length} figure(s) that are not in the evidence` : undefined) };
  } catch (e) {
    return {
      result: { markdown: renderOrder(facts, offlineNarrative(facts)), scrubbed: [], author: 'offline', facts },
      llm: acc.provenance(`offline path: ${(e as Error).message}`),
    };
  }
}

/** Replace tokens with their values, then remove any digit run the evidence does not contain. */
function scrub(raw: unknown, tokens: Record<string, string>, removed: string[], section: string): string {
  let text = String(raw ?? '').trim();
  text = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => {
    const v = tokens[key];
    if (v === undefined) {
      removed.push(`${section}: unknown token ${whole}`);
      return '';
    }
    return v;
  });
  const approved = new Set(Object.values(tokens).map(normaliseFigure));
  text = text.replace(/\d[\d,.]*/g, (run) => {
    if (approved.has(normaliseFigure(run))) return run;
    removed.push(`${section}: "${run}" is not in the evidence`);
    return '[no figure in evidence]';
  });
  return text;
}

function normaliseFigure(s: string): string {
  return s.replace(/,/g, '').replace(/\.$/, '').trim();
}

function offlineNarrative(f: ChangeOrderFacts): Record<string, string> {
  const controls = f.controls.map((c) => `${c.label} (${c.tier})`).join('; ');
  return {
    scope: `Change of the controlled procedure ${f.procedureId}, from revision ${f.from} to ${f.to}. The plant configuration, the crew and the shift count are unchanged.`,
    whatChanged: controls ? `Adopts: ${controls}. Nothing else in the document is edited.` : 'No control earned adoption, so this order records a null result and the procedure stays as issued.',
    rationale: f.controls.map((c) => `${c.label}: ${c.describe}`).join(' ') || 'The tested controls did not change the mechanism the finding rests on.',
    tested: `${f.shifts} paired shifts per arm under the ${f.method} derivation, same scenario indices, same crew and configuration, with false discovery correction across the whole candidate set.`,
    rejected: f.rejected.length ? f.rejected.map((r) => `${r.id}: ${r.why}`).join('; ') : 'No candidate was rejected.',
    residualRisk: `Failure rate moves from ${f.failureBasePct}% to ${f.failureNewPct}% with a paired interval of ${f.ciPts} percentage points and a one-sided risk of ${f.riskPct}%. Mean time with hazard in effect changes by ${f.hazardDeltaS}s per shift and ${f.addedSeconds}s of crew time is added. The mechanism remaining is whatever the adopted controls do not reach; this order does not claim the sequence is safe, only that it is measurably thinner.`,
    verification: 'Issue the revised document under the normal controlled-copy process, brief the crews on shift handover, and confirm the first execution against the new text with the superintendent present.',
  };
}

/** The order itself. Every figure in this document is interpolated here, from `facts`. */
function renderOrder(f: ChangeOrderFacts, narrative: Record<string, string>, scrubbed: string[] = []): string {
  const controlRows = f.controls.length
    ? f.controls.map((c) => `| ${c.label} | ${c.tier} | ${c.describe} | ${c.targets.join(', ') || 'configuration'} | ${c.annualCostEur.toLocaleString('en-US')} | ${c.addedSeconds} |`).join('\n')
    : '| none adopted | - | the loop rejected every candidate | - | - | - |';
  const rejected = f.rejected.length
    ? f.rejected.map((r) => `- **${r.id}** - ${r.why}`).join('\n')
    : '- nothing was tested beyond the adopted set';

  return `# ${f.order} - change of controlled procedure

| | |
|---|---|
| Procedure | ${f.procedureId} |
| From revision | ${f.from} |
| To revision | ${f.to} |
| Evidence | ${f.shifts} paired shifts per arm, ${f.method} derivation |
| Origin | ${f.riskPct === '100' ? 'no accepted effect' : 'procedural fuzzing run'} |

## 1. What changed

${narrative.whatChanged}

${narrative.scope}

| Control | Tier | Mechanism | Acts on | EUR/year | Crew s/shift |
|---|---|---|---|---|---|
${controlRows}

## 2. Measured effect

Figures in this section are taken directly from the run record; no figure in this order was written by the drafting agent.

| Quantity | Baseline | Revised | Paired difference |
|---|---|---|---|
| Failure rate | ${f.failureBasePct}% | ${f.failureNewPct}% | ${f.deltaPts} pts (95% interval ${f.ciPts} pts) |
| Near-miss rate | ${f.nearMissBasePct}% | ${f.nearMissNewPct}% | - |
| Mean release | ${f.releaseBaseM3} m3/shift | ${f.releaseNewM3} m3/shift | - |
| Annual expected loss | EUR ${f.annualLossBaseEur} | EUR ${f.annualLossNewEur} | EUR ${f.annualGainEur} |
| Control cost | - | EUR ${f.controlCostEur} | net EUR ${f.netEur} |

One-sided risk of a false positive: ${f.riskPct}% across ${f.iterations} bootstrap replicates. Mean time in hazard changes by ${f.hazardDeltaS} s per shift.

${narrative.tested}

## 3. What was tested and rejected

${rejected}

${narrative.rejected}

## 4. Residual risk

${narrative.residualRisk}

## 5. Implementation and verification

${narrative.verification}

${narrative.rationale}

## 6. Signatures

| Role | Name | Signature | Date |
|---|---|---|---|
| Prepared by (process safety) | | | |
| Reviewed by (operations superintendent) | | | |
| Reviewed by (shift crew representative) | | | |
| Approved by (site manager) | | | |

Drafted by MURPHY under ${f.order}. The model that produced the prose is recorded in the API response, not asserted here${scrubbed.length ? `; ${scrubbed.length} figure(s) absent from the evidence were removed before issue` : ''}.
`;
}
