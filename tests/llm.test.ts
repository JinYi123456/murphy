import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  available, chat, extractJsonBlock, llmStatus, parseJsonObject, resetLlmProbe,
} from '../src/lib/llm/client';
import {
  changeOrderFacts, draftChangeOrder, parseProcedure, reviewFinding, ruleReview, writeErrorScenario,
  type Finding, type RepairLoopResult,
} from '../src/lib/llm/agents';
import { inspectModel } from '../src/engine/model';
import { getTwin } from '../src/engine/twins/index';
import { PLANTS, PERSONAS, PROCEDURES } from '../src/lib/registry';
import type { PairedEffect } from '../src/engine/stats';
import type { SummaryDto } from '../src/lib/dto';
import type { VariantVerdict } from '../src/engine/batch';
import type { CandidateTrial } from '../src/lib/fuzz';
import { POST as parseRoute } from '../src/app/api/agents/parse/route';
import { POST as scenarioRoute } from '../src/app/api/agents/scenario/route';
import { POST as reviewRoute } from '../src/app/api/agents/review/route';
import { POST as changeOrderRoute } from '../src/app/api/agents/change-order/route';

/**
 * Provenance is the product. These tests do not check that a model is clever; they
 * check that a completion is parsed honestly, that an invented plant variable never
 * reaches the physics, and that every result which did not come from the served
 * model says so.
 */

const KEY = 'amd-secret-DO-NOT-LEAK';
const LLM_ENV = ['AMD_VLLM_BASE_URL', 'AMD_VLLM_API_KEY', 'AMD_VLLM_MODEL', 'AMD_VLLM_MAX_TOKENS', 'AMD_VLLM_TIMEOUT_MS', 'AMD_VLLM_JSON_MODE'];
const SOP = readFileSync('data/sop/OP-TRF-014.md', 'utf8');

function clearEnv(): void {
  for (const name of LLM_ENV) delete process.env[name];
  resetLlmProbe();
}

function serve(): void {
  process.env.AMD_VLLM_BASE_URL = 'http://gpu.test:8000/v1';
  process.env.AMD_VLLM_MODEL = 'served-8b';
  process.env.AMD_VLLM_API_KEY = KEY;
  resetLlmProbe();
}

interface Sent {
  url: string;
  payload: { messages?: { role: string; content: string }[]; max_tokens?: number; response_format?: unknown; model?: string };
  init: RequestInit;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Fake vLLM. The reachability probe is a 4-token request and is answered apart from
 * the scripted agent calls, so a test counts exactly the rounds it claims.
 */
function fakeLlm(answer: (call: Sent) => string | Response): { fetch: ReturnType<typeof vi.fn>; calls: Sent[] } {
  const calls: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Sent['payload'];
    const sent = { url: String(url), payload, init };
    calls.push(sent);
    if (payload.max_tokens === 4) return json({ model: 'served-8b', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const reply = answer(sent);
    if (typeof reply !== 'string') return reply;
    return json({ model: 'served-8b', choices: [{ message: { content: reply } }], usage: { prompt_tokens: 120, completion_tokens: 64 } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls };
}

/* -------------------------------------------------------------------- fixtures */

interface ProcedureJson {
  id: string; title: string; twin: string; revision: string; language: string; roles: string[]; summary: string; steps: unknown[];
}

const stepOf = (id: string) => PROCEDURES[0].steps.find((s) => s.id === id)!;

function modelProcedure(over: Partial<ProcedureJson> = {}): ProcedureJson {
  return {
    id: 'OP-TRF-014',
    title: 'Transfer of product from road tanker to storage tank TK-101',
    twin: 'tank_transfer',
    revision: '7',
    language: 'en',
    roles: ['field operator'],
    summary: 'Line up, start and monitor a flammable liquid transfer.',
    steps: [{ id: 'd1', title: 'Hold a valid transfer permit', text: 'Hold a valid transfer permit for the tank named on the dispatch note.', role: 'field operator', cue: 'document', kind: 'authorise', durS: 120 }],
    ...over,
  };
}

function makeFinding(over: Partial<Finding> = {}): Finding {
  const step = stepOf('d4');
  return {
    id: 'F-d4-wrong_target',
    procedureId: PROCEDURES[0].id,
    revision: PROCEDURES[0].revision,
    method: 'sparh',
    step,
    error: step.errors?.[0],
    kind: 'wrong_target',
    hep: {
      p: 0.01,
      nominal: 0.001,
      multiplier: 10,
      lo: 0.0033,
      hi: 0.03,
      basis: 'SPAR-H nominal action HEP 1.0E-03 (CR-6883)',
      adjusted: false,
      rows: [
        { id: 'HCI', label: 'Ergonomics / HMI', level: 'adequate', mult: 2, why: 'adjacent identical devices' },
        { id: 'E-T', label: 'Experience and training', level: 'average', mult: 5, why: 'two months in the job' },
      ],
      suppressed: [],
    },
    conditions: ['confusable_device', 'low_experience'],
    stats: { reached: 4000, thrown: 44, caught: 12, escaped: 32, causal: 9, n: 4000 },
    persona: PERSONAS[1].label,
    plant: PLANTS[1].label,
    outcome: 'minor_release',
    ...over,
  };
}

function effect(over: Partial<PairedEffect> = {}): PairedEffect {
  return { delta: -0.0031, baseMean: 0.0085, candMean: 0.0054, ciLow: -0.0042, ciHigh: -0.0021, oneSidedRisk: 0.002, iterations: 2000, ...over };
}

function summary(over: Partial<SummaryDto> = {}): SummaryDto {
  return {
    variantId: 'OP-TRF-014/7/baseline', seed: 'murphy-default', n: 4000, failed: 34, failureRate: 0.0085, nearMissRate: 0.021,
    incidents: 8, incidentRate: 0.002, upsets: 41, upsetRate: 0.0103,
    outcomeCounts: { normal: 3966, minor_release: 26, overfill: 8 }, perStep: {}, meanCostEur: 1200,
    costCi: { mean: 1200, ciLow: 900, ciHigh: 1500 }, p95CostEur: 6000, cvarCostEur: 9000, meanReleaseM3: 0.041,
    meanElapsedS: 2100, meanHazardS: 12.5, shiftsPerYear: 420, annualLossEur: 504000, annualEscalatedEur: 604000,
    wallMs: 800, shiftsPerSecond: 5000, worst: [], ...over,
  };
}

function verdict(over: Partial<VariantVerdict> = {}): VariantVerdict {
  return {
    failure: effect(), cost: effect({ delta: -180, ciLow: -260, ciHigh: -90 }), failureP: 0.004, costP: 0.01,
    annualGainEur: 74000, interventionCostEur: 26000, netEur: 48000, accepted: true, reasons: [], ...over,
  };
}

function trialOf(id: string, accepted: boolean): CandidateTrial {
  return {
    control: { id, label: id, tier: 'engineering', describe: `the ${id} control`, annualCostEur: id === 'forced_control' ? 26000 : 6500, addedSeconds: 15 },
    targets: ['d4'],
    summary: summary({ variantId: `OP-TRF-014/7/${id}`, failureRate: accepted ? 0.0054 : 0.0081 }),
    verdict: verdict({ accepted, reasons: accepted ? [] : ['net annual gain EUR 400 is below the EUR 1000 threshold'] }),
  };
}

function makeLoop(): RepairLoopResult {
  return {
    procedureId: 'OP-TRF-014',
    revision: '7',
    config: { persona: PERSONAS[1].id, plant: PLANTS[1].id, method: 'sparh', seed: 'murphy-default', shifts: 4000 },
    baseline: summary(),
    stacked: { summary: summary({ variantId: 'OP-TRF-014/7+forced_control', failureRate: 0.0054, meanHazardS: 9.1 }), verdict: verdict(), controls: ['forced_control'] },
    trials: [trialOf('forced_control', true), trialOf('freeboard_policy', false)],
  };
}

/* --------------------------------------------------------------------- tests */

beforeEach(() => {
  vi.unstubAllGlobals();
  clearEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEnv();
});

describe('brace matcher', () => {
  it('takes the first balanced object out of adversarial text', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonBlock('sure, here: {"a":"} not a close"} hope that helps')).toBe('{"a":"} not a close"}');
    expect(extractJsonBlock('{"note":"he said \\"}\\" loudly","n":2}')).toBe('{"note":"he said \\"}\\" loudly","n":2}');
    expect(extractJsonBlock("don't let an apostrophe fool you {\"ok\":true}")).toBe('{"ok":true}');
    expect(extractJsonBlock('{"a":{"b":[1,2,{"c":3}]}}')).toBe('{"a":{"b":[1,2,{"c":3}]}}');
    expect(extractJsonBlock('```json\n{"a":{"b":1}}\n```')).toBe('{"a":{"b":1}}');
    expect(extractJsonBlock('{ stray brace then the real answer\n{"a":1}')).toBe('{"a":1}');
    expect(extractJsonBlock('{"a":"nested { brace } in a string"}')).toBe('{"a":"nested { brace } in a string"}');
  });

  it('refuses what is not an object', () => {
    expect(extractJsonBlock('{"truncated": ')).toBeNull();
    expect(extractJsonBlock('nothing here at all')).toBeNull();
    expect(extractJsonBlock('[1,2,3]')).toBeNull();
    expect(extractJsonBlock('{"a":1,,}')).toBeNull();
    expect(parseJsonObject('not json')).toBeNull();
    expect(parseJsonObject('[1,2]')).toBeNull();
  });
});

describe('chat', () => {
  it('posts to the OpenAI-compatible path and reports accounting', async () => {
    serve();
    const { calls } = fakeLlm(() => '{"ok":true}');
    const res = await chat([{ role: 'user', content: 'hi' }], { maxTokens: 40 });
    expect(calls[0].url).toBe('http://gpu.test:8000/v1/chat/completions');
    expect(calls[0].init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(res).toMatchObject({ text: '{"ok":true}', promptTokens: 120, completionTokens: 64, model: 'served-8b' });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('retries a 5xx once and never retries a 4xx', async () => {
    serve();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return n === 1 ? new Response('upstream gone', { status: 503 }) : json({ choices: [{ message: { content: '{"ok":1}' } }] });
    }));
    const res = await chat([{ role: 'user', content: 'x' }], { maxTokens: 20 });
    expect(res.text).toBe('{"ok":1}');
    expect(n).toBe(2);

    const refused = vi.fn(async () => new Response('{"error":"model not found"}', { status: 404 }));
    vi.stubGlobal('fetch', refused);
    await expect(chat([{ role: 'user', content: 'x' }], { maxTokens: 20 })).rejects.toThrow(/HTTP 404/);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('treats a timeout as a transport fault worth one retry', async () => {
    serve();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return json({ choices: [{ message: { content: '{"ok":2}' } }] });
    }));
    const res = await chat([{ role: 'user', content: 'x' }], { maxTokens: 20 });
    expect(res.text).toBe('{"ok":2}');
    expect(n).toBe(2);
  });

  it('asks for JSON in the prompt unless the stack declares response_format support', async () => {
    serve();
    const { calls } = fakeLlm(() => '{"ok":true}');
    await chat([{ role: 'user', content: 'give me json' }], { json: true, maxTokens: 30 });
    expect(calls[0].payload.response_format).toBeUndefined();
    expect(calls[0].payload.messages?.at(-1)?.content).toContain('one JSON object only');

    process.env.AMD_VLLM_JSON_MODE = '1';
    await chat([{ role: 'user', content: 'give me json' }], { json: true, maxTokens: 30 });
    expect(calls[1].payload.response_format).toEqual({ type: 'json_object' });
  });

  it('reports presence, and costs no request when nothing is configured', async () => {
    clearEnv();
    expect(llmStatus()).toEqual({
      configured: false,
      base: null,
      model: null,
      note: 'no served model configured; every agent runs on its deterministic path',
    });
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(available()).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();

    serve();
    const { calls } = fakeLlm(() => '{"ok":true}');
    await expect(available()).resolves.toBe(true);
    await expect(available()).resolves.toBe(true);
    expect(calls.length).toBe(1);
  });

  it('never lets the key into a status object or an error message', async () => {
    serve();
    const status = JSON.stringify(llmStatus());
    expect(status).not.toContain(KEY);
    expect(status).toContain('key present');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(`auth failed for ${KEY}`, { status: 401 })));
    await expect(chat([{ role: 'user', content: 'x' }], { maxTokens: 20 })).rejects.toThrow(/HTTP 401/);
  });
});

describe('parseProcedure', () => {
  it('accepts a model compilation and drops plant variables the twin does not have', async () => {
    serve();
    const step = {
      id: 'd4', title: 'Open V1', text: 'Open the tank inlet valve V1 on TK-101.', role: 'field operator', cue: 'label', kind: 'actuate', durS: 90,
      applies: { V1: 1, PRESSURE_X: 3 },
      errors: [
        { id: 'd4e1', kind: 'wrong_target', weight: 40, text: 'Opened the neighbour on the same manifold.', patch: { set: { V2: 1, NOT_A_TAG: 1 } }, source: 'model' },
        { id: 'd4e2', kind: 'misread', weight: 60, text: 'Read the wrong plate.', source: 'model' },
      ],
    };
    const { calls } = fakeLlm(() => JSON.stringify(modelProcedure({ steps: [step] })));
    const { result, llm } = await parseProcedure(SOP);

    expect(llm.used).toBe(true);
    expect(result.author).toBe('model');
    expect(result.integrity.ok).toBe(true);
    expect(inspectModel(result.procedure).ok).toBe(true);
    expect(result.procedure.steps[0].applies).toEqual({ V1: 1 });
    expect(result.procedure.steps[0].errors?.[0].patch).toEqual({ V2: 1 });
    expect(result.dropped.join(' ')).toContain('PRESSURE_X');
    expect(result.dropped.join(' ')).toContain('NOT_A_TAG');
    expect(calls.length).toBe(2);
    expect(calls[1].payload.messages?.[0].content).toContain('Never invent one');
  });

  it('returns the validator errors to the model once, then accepts', async () => {
    serve();
    let agentCalls = 0;
    fakeLlm(() => {
      agentCalls++;
      return agentCalls === 1 ? JSON.stringify(modelProcedure({ steps: [] })) : JSON.stringify(modelProcedure());
    });
    const { result, llm } = await parseProcedure(SOP);
    expect(llm.used).toBe(true);
    expect(result.corrections).toBe(1);
    expect(result.author).toBe('model');
    expect(result.procedure.steps).toHaveLength(1);
  });

  it('gives up to the deterministic compiler when the gate keeps rejecting', async () => {
    serve();
    const { calls } = fakeLlm(() => 'I cannot produce JSON for this document.');
    const { result, llm } = await parseProcedure(SOP);
    expect(calls.length).toBe(3);
    expect(result.author).toBe('offline');
    // tokens were spent, but the model did not write this procedure
    expect(llm.used).toBe(false);
    expect(llm.tokens?.completion).toBe(128);
    expect(result.dropped.join(' ')).toContain('fallback');
    expect(inspectModel(result.procedure).ok).toBe(true);
  });

  it('compiles the real SOP offline into a model the engine accepts', async () => {
    const { result, llm } = await parseProcedure(SOP);
    expect(llm.used).toBe(false);
    expect(llm.reason).toContain('offline path');
    expect(result.author).toBe('offline');
    expect(result.procedure.id).toBe('OP-TRF-014');
    expect(result.procedure.steps.length).toBeGreaterThanOrEqual(17);
    expect(result.procedure.steps.some((s) => s.kind === 'recover' && s.emergency)).toBe(true);
    expect(result.procedure.steps.every((s) => Object.keys(s.applies ?? {}).length === 0)).toBe(true);
    expect(result.integrity.ok).toBe(true);
    expect(result.integrity.notes.join(' ')).toContain('offline rule');
  });
});

describe('writeErrorScenario', () => {
  const step = stepOf('d6');
  const persona = PERSONAS[1];
  const plant = PLANTS[1];

  it('validates every patch key against the twin and rejects the rest', async () => {
    serve();
    const { calls } = fakeLlm(() => JSON.stringify({
      text: 'He closes V3 from the walkway, two turns short of the seat, because the handwheel stops easy when the packing is stiff.',
      symptom: 'the manifold sounds quiet, which is what a closed valve sounds like',
      patchKeys: ['V3', 'level', 'TK-999'],
    }));
    const { result, llm } = await writeErrorScenario(step, persona, plant, 'wrong_target');
    expect(llm.used).toBe(true);
    expect(result.patchKeys).toEqual(['V3', 'level']);
    expect(result.patch).toEqual({ V3: 1 });
    expect(result.unresolved).toEqual(['level']);
    expect(llm.reason).toContain('TK-999');
    const prompt = String(calls[1].payload.messages?.[1].content);
    expect(prompt).toContain('Variable names you may use');
    expect(prompt).toContain(persona.label);
    expect(prompt).toContain('isolated at start');
  });

  it('builds a grounded scenario offline when no service is configured', async () => {
    const { result, llm } = await writeErrorScenario(step, persona, plant, 'incomplete');
    expect(llm.used).toBe(false);
    expect(result.source).toBe('offline');
    expect(result.kind).toBe('incomplete');
    expect(result.text.length).toBeGreaterThan(40);
    const twin = getTwin(plant.twin ?? 'tank_transfer');
    for (const k of result.patchKeys) expect(twin.discIndex(k) >= 0 || twin.varIndex(k) >= 0).toBe(true);
    expect(result.patchKeys).toContain('V3');
    expect(result.patch.V3).toBeDefined();
  });
});

describe('reviewFinding', () => {
  it('is shown the derivation rows, not the prose alone', async () => {
    serve();
    const { calls } = fakeLlm(() => JSON.stringify({ verdict: 'drop', confidence: 0.8, reason: 'd7 walks the line and sees the manifold' }));
    const { result, llm } = await reviewFinding(makeFinding());
    expect(llm.used).toBe(true);
    expect(result).toMatchObject({ findingId: 'F-d4-wrong_target', verdict: 'drop', confidence: 0.8 });
    const prompt = String(calls[1].payload.messages?.[1].content);
    expect(prompt).toContain('HEP derivation');
    expect(prompt).toContain('Ergonomics / HMI');
    expect(prompt).toContain('adequate');
  });

  it('keeps a verdict it cannot parse off the record and argues by rule instead', async () => {
    serve();
    fakeLlm(() => 'looks fine to me, nothing to report');
    const { result, llm } = await reviewFinding(makeFinding());
    expect(llm.used).toBe(false);
    expect(llm.reason).toContain('offline path');
    expect(result.verdict).toBe('retain');
    expect(result.reason).toContain('could not sustain one');
  });

  it('the rule reviewer drops a finding a forced control already blocks', () => {
    const step = stepOf('d4');
    const v = ruleReview(makeFinding({ step: { ...step, applies: { ...step.applies, INTERLOCKED: 1 } } }));
    expect(v.verdict).toBe('drop');
    expect(v.reason).toContain('interlock');
  });

  it('the rule reviewer revises a probability the rows do not produce', () => {
    const v = ruleReview(makeFinding({ hep: { ...makeFinding().hep, p: 0.5 } }));
    expect(v.verdict).toBe('revise');
    expect(v.reason).toContain('Not credible as written');
    expect(v.revision).toBeTruthy();
  });
});

describe('draftChangeOrder', () => {
  it('interpolates the evidence and refuses figures the evidence does not contain', async () => {
    serve();
    fakeLlm(() => JSON.stringify({
      scope: 'Applies to the tank transfer procedure, effective 1974.',
      whatChanged: 'Keys the inlet so only V1 can be moved, cutting failure by {{delta_pts}} points.',
      rationale: 'Removes the wrong-target mode instead of asking for more care.',
      tested: 'Paired over {{shifts}} shifts with {{method}} rates.',
      rejected: 'freeboard_policy: net annual gain EUR 400 is below the threshold.',
      residualRisk: 'The interlock can still fail on demand.',
      verification: 'Signed at handover by the superintendent.',
    }));
    const { result, llm } = await draftChangeOrder(makeLoop());
    const facts = changeOrderFacts(makeLoop());

    expect(llm.used).toBe(true);
    expect(result.author).toBe('model');
    expect(result.markdown).toContain(facts.deltaPts);
    expect(result.markdown).toContain('4,000');
    expect(result.markdown).toContain('26,000');
    expect(result.scrubbed.join(' ')).toContain('1974');
    expect(result.markdown).not.toContain('1974');
    expect(result.markdown).toContain('[no figure in evidence]');
    expect(result.markdown).toContain('## 6. Signatures');
    expect(result.markdown).toContain('freeboard_policy');
  });

  it('writes the whole order itself when no model is configured', async () => {
    const { result, llm } = await draftChangeOrder(makeLoop());
    expect(llm.used).toBe(false);
    expect(llm.reason).toContain('offline path');
    expect(result.author).toBe('offline');
    expect(result.scrubbed).toEqual([]);
    for (const heading of ['## 1. What changed', '## 2. Measured effect', '## 3. What was tested and rejected', '## 4. Residual risk', '## 5. Implementation']) {
      expect(result.markdown).toContain(heading);
    }
    expect(result.markdown).toContain(result.facts.failureBasePct);
    expect(result.markdown).toContain('freeboard_policy');
    expect(result.markdown).toContain('below the EUR 1000 threshold');
  });
});

describe('agent routes', () => {
  function post(path: string, body: unknown): Request {
    return new Request(`http://murphy.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('every route answers on its deterministic path with no model configured', async () => {
    process.env.AMD_VLLM_API_KEY = KEY;
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const parsed = await (await parseRoute(post('/api/agents/parse', { markdown: SOP }))).json();
    expect(parsed.llm).toMatchObject({ used: false });
    expect(parsed.author).toBe('offline');
    expect(parsed.procedure.steps.length).toBeGreaterThan(10);

    const scenario = await (await scenarioRoute(post('/api/agents/scenario', { procedureId: 'OP-TRF-014', stepId: 'd12', personaId: 'night_trainee', plantId: 'tk_after_instrument_work', kind: 'delayed_response' }))).json();
    expect(scenario.llm.used).toBe(false);
    expect(scenario.source).toBe('offline');
    expect(scenario.twin).toBe('tank_transfer');

    const review = await (await reviewRoute(post('/api/agents/review', { findings: [makeFinding()] }))).json();
    expect(review.llm.used).toBe(false);
    expect(review.verdicts).toHaveLength(1);
    expect(['retain', 'drop', 'revise']).toContain(review.verdicts[0].verdict);

    const order = await (await changeOrderRoute(post('/api/agents/change-order', { loop: makeLoop() }))).json();
    expect(order.llm.used).toBe(false);
    expect(order.author).toBe('offline');
    expect(order.markdown).toContain('MOC-OP-TRF-014');

    expect(spy).not.toHaveBeenCalled();
  });

  it('no route response carries the API key, and bad input is refused', async () => {
    process.env.AMD_VLLM_API_KEY = KEY;

    const texts = await Promise.all([
      parseRoute(post('/api/agents/parse', { markdown: SOP })).then((r) => r.text()),
      scenarioRoute(post('/api/agents/scenario', { stepId: 'd4' })).then((r) => r.text()),
      reviewRoute(post('/api/agents/review', { findings: [makeFinding()] })).then((r) => r.text()),
      changeOrderRoute(post('/api/agents/change-order', { loop: makeLoop() })).then((r) => r.text()),
    ]);
    for (const text of texts) expect(text).not.toContain(KEY);

    const empty = await parseRoute(post('/api/agents/parse', {}));
    expect(empty.status).toBe(400);
    expect((await empty.json()).llm.used).toBe(false);

    const unknownStep = await scenarioRoute(post('/api/agents/scenario', { stepId: 'does-not-exist', personaId: 'night_trainee', plantId: 'tk_asdesigned' }));
    expect(unknownStep.status).toBe(400);

    const noFindings = await reviewRoute(post('/api/agents/review', {}));
    expect(noFindings.status).toBe(400);

    const tooMany = await reviewRoute(post('/api/agents/review', { findings: new Array(61).fill(makeFinding()) }));
    expect(tooMany.status).toBe(413);

    // with a served model the cap is the GPU's, not the rule reviewer's
    serve();
    fakeLlm(() => JSON.stringify({ verdict: 'retain', confidence: 0.5, reason: 'no objection survived' }));
    const overModelCap = await reviewRoute(post('/api/agents/review', { findings: new Array(13).fill(makeFinding()) }));
    expect(overModelCap.status).toBe(413);

    const inside = await (await reviewRoute(post('/api/agents/review', { findings: new Array(2).fill(makeFinding()) }))).json();
    expect(inside.verdicts).toHaveLength(2);
    expect(inside.llm).toMatchObject({ used: true, calls: 2 });
    expect(JSON.stringify(inside)).not.toContain(KEY);

    const noLoop = await changeOrderRoute(post('/api/agents/change-order', {}));
    expect(noLoop.status).toBe(400);
  });
});
