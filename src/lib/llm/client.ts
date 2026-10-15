/**
 * Client for open-weight models served on AMD Instinct behind an
 * OpenAI-compatible endpoint (vLLM, LMDeploy, TGI's OpenAI shim).
 *
 * Two rules shape this file.
 *
 *  1. The service is optional. A judge demoing the product on a laptop, or a
 *     GPU box that has been reclaimed overnight, must still get an answer - the
 *     same routes, with the deterministic path labelled as such. So every
 *     failure here is an ordinary return value for the caller to degrade on,
 *     not an unhandled rejection.
 *  2. A served model is not a cloud model. `response_format: json_object` is
 *     not implemented by every stack, and the ones that do implement it are
 *     frequently the smaller open-weight checkpoints that ignore it silently.
 *     The prompt therefore always says what shape is wanted, and parsing is
 *     defensive, so correctness never depends on the sampler cooperating.
 *
 * Read env on every call rather than at import: `process.env` is only fully
 * populated after the framework has loaded `.env`, and a module-level snapshot
 * would freeze "not configured" into the build output.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** request a single JSON object; honoured as `response_format` only when the stack declares support */
  json?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  model: string;
  /** full URL the request went to, so provenance can name the machine that answered */
  endpoint: string;
}

export interface LlmStatus {
  configured: boolean;
  base: string | null;
  model: string | null;
  note: string;
}

export class LlmError extends Error {
  readonly status: number;
  /** only transport faults and server-side failures qualify; a 4xx is a contract problem */
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** One retry, modest backoff: a batch of agents hitting one GPU can catch the server mid-preempt. */
const RETRY_BACKOFF_MS = 1200;
/** The probe is a real request, so its answer is held briefly instead of paid for per call. */
const PROBE_TTL_MS = 10_000;

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function llmBase(): string | null {
  const raw = process.env.AMD_VLLM_BASE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function llmModel(): string | null {
  const raw = process.env.AMD_VLLM_MODEL?.trim();
  return raw ? raw : null;
}

/**
 * Some serving builds reject an unknown `response_format` outright, which would
 * take the whole feature down on the wrong machine. Default is off: ask for
 * JSON in words, and only send the field when the operator opts in.
 */
export function jsonModeEnabled(): boolean {
  return process.env.AMD_VLLM_JSON_MODE?.trim() === '1';
}

export function llmConfigured(): boolean {
  return llmBase() !== null && llmModel() !== null;
}

/** Presence only. A credential is never returned, echoed or logged anywhere in this module. */
export function llmStatus(): LlmStatus {
  const base = llmBase();
  const model = llmModel();
  const key = process.env.AMD_VLLM_API_KEY?.trim();
  return {
    configured: base !== null && model !== null,
    base,
    model,
    note: !base || !model
      ? 'no served model configured; every agent runs on its deterministic path'
      : `${key ? 'key present' : 'no key, endpoint assumed unauthenticated'}; json mode ${jsonModeEnabled() ? 'on' : 'in-prompt only'}, max ${num('AMD_VLLM_MAX_TOKENS', 900)} tokens, ${num('AMD_VLLM_TIMEOUT_MS', 45_000)} ms budget`,
  };
}

const JSON_INSTRUCTION =
  'Answer with one JSON object only: no prose before or after it, no Markdown fence, no commentary.';

function withJsonInstruction(messages: ChatMessage[], json: boolean, sendFormat: boolean): ChatMessage[] {
  if (!json || sendFormat) return messages;
  const last = messages[messages.length - 1];
  if (last?.content.includes(JSON_INSTRUCTION)) return messages;
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${JSON_INSTRUCTION}` }];
}

/**
 * Ask for a completion.
 *
 * Token counts come from the server's `usage` when it reports them and are
 * otherwise zero rather than estimated - a guessed token count in a provenance
 * panel is a lie of the same kind the rest of this product is built to avoid.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const base = llmBase();
  const model = llmModel();
  if (!base || !model) throw new LlmError('no served model configured (AMD_VLLM_BASE_URL / AMD_VLLM_MODEL)', 0, false);

  const endpoint = `${base}/chat/completions`;
  const sendFormat = Boolean(opts.json) && jsonModeEnabled();
  const payload: Record<string, unknown> = {
    model,
    messages: withJsonInstruction(messages, Boolean(opts.json), sendFormat),
    max_tokens: opts.maxTokens ?? num('AMD_VLLM_MAX_TOKENS', 900),
    temperature: opts.temperature ?? 0.1,
  };
  if (sendFormat) payload.response_format = { type: 'json_object' };

  const timeoutMs = opts.timeoutMs ?? num('AMD_VLLM_TIMEOUT_MS', 45_000);
  let last: LlmError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      return await postChat(endpoint, payload, model, timeoutMs);
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError(`${endpoint} failed: ${(e as Error).message}`, 0, true);
      if (!err.retryable || attempt === 2) throw err;
      last = err;
    }
  }
  throw last ?? new LlmError(`${endpoint} produced no answer`, 0, false);
}

async function postChat(endpoint: string, payload: Record<string, unknown>, model: string, timeoutMs: number): Promise<ChatResult> {
  const key = process.env.AMD_VLLM_API_KEY?.trim();
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      // per attempt, so the retry gets its own full budget rather than the leftovers
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string }).name;
    const message = (e as Error).message ?? 'fetch failed';
    const text = name === 'TimeoutError' || name === 'AbortError' ? `did not answer within ${timeoutMs} ms` : `unreachable (${message})`;
    throw new LlmError(`AMD inference service ${text}`, 0, true);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new LlmError(`AMD inference service returned HTTP ${res.status}: ${body}`, res.status, res.status >= 500);
  }

  const j = (await res.json()) as {
    choices?: { message?: { content?: string }; text?: string }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.text ?? '';
  if (!text.trim()) throw new LlmError(`AMD inference service returned an empty completion for ${model}`, 0, true);

  return {
    text,
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    model: j.model ?? model,
    endpoint,
  };
}

let probe: { at: number; ok: boolean; reason: string } | null = null;

export function resetLlmProbe(): void {
  probe = null;
}

/**
 * Hard reachability probe used by the routes and the agents.
 *
 * Unconfigured is a fact, so it costs nothing. Configured is checked with a real
 * one-token request, because a base URL that answers DNS but has no model behind
 * it is exactly the state in which an agent would otherwise hang for 45 seconds.
 */
export async function availability(timeoutMs = 6000): Promise<{ ok: boolean; reason: string }> {
  if (!llmConfigured()) return { ok: false, reason: 'AMD_VLLM_BASE_URL / AMD_VLLM_MODEL not set' };
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe;
  let result: { ok: boolean; reason: string };
  try {
    await chat([{ role: 'user', content: 'ping' }], { maxTokens: 4, timeoutMs });
    result = { ok: true, reason: 'served model answered' };
  } catch (e) {
    result = { ok: false, reason: (e as Error).message };
  }
  probe = { at: Date.now(), ...result };
  return probe;
}

export async function available(timeoutMs = 6000): Promise<boolean> {
  return (await availability(timeoutMs)).ok;
}

/**
 * First balanced JSON object in a completion.
 *
 * Written by hand rather than with a regular expression because the models do
 * emit prose around the answer, and prose contains braces: `"the {valve} tag"`
 * inside a string must not be counted, an escaped quote must not close a string,
 * and a truncated object must not be mistaken for one. A candidate slice is only
 * returned once it parses, so a mis-counted brace costs a retry, not a wrong
 * procedure.
 */
export function extractJsonBlock(text: string): string | null {
  const body = stripFence(text);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '{') continue;
    const end = matchObject(body, i);
    // an unclosed brace is either stray prose or a truncated answer; keep looking
    if (end < 0) continue;
    const slice = body.slice(i, end + 1);
    if (parsesAsObject(slice)) return slice;
  }
  return null;
}

export function parseJsonObject(text: string): unknown | null {
  const block = extractJsonBlock(text);
  if (!block) return null;
  try {
    const v = JSON.parse(block) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Scan forward to the brace that closes the object opened at `start`, or -1 if it never closes. */
function matchObject(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    // only the double quote is a delimiter: it is the only one JSON has, and
    // treating an apostrophe as one would let "don't" swallow the rest of the text
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function parsesAsObject(s: string): boolean {
  try {
    const v = JSON.parse(s) as unknown;
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function stripFence(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fence ? fence[1] : text;
}
