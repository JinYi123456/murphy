import { recordLedger, blocksUsed, ledgerSummary, type EvolusBlock, type LedgerEntry } from './ledger';
import type { ChatMessage } from '../llm/client';

/**
 * Client for the Evolus business-agent platform, to the contract in their
 * developer documentation.
 *
 * The parts of that contract that are easy to get wrong are the parts this file
 * is careful about:
 *
 *  - workflow execution is multipart/form-data, not JSON, and answers 202 with a
 *    job id plus an `X-Workflow-Execution-Id` header; the result is polled, not
 *    awaited;
 *  - `run-media` takes its `options` as a JSON query parameter, while `run` takes
 *    them in the body;
 *  - `run-file` exists only for `translate` and `anonymize`, and bills through
 *    the `X-Credits-Consumed` header rather than the body;
 *  - ask-file extractors are synchronous and the body is the data, so there is no
 *    envelope to unwrap;
 *  - agent chat is a different base, a different auth scheme, and a model id of
 *    `<applicationId>:<agentId>`; `temperature` is ignored by the platform, so it
 *    is not sent;
 *  - failures are RFC-9110 `application/problem+json` with `errorCode` and
 *    `traceId`, which is the only useful thing a log line can carry.
 *
 * Credentials are read from `process.env` on every call and are never returned,
 * logged or written into the ledger. Errors pass through `redact()` so that a key
 * echoed by a proxy cannot reach a browser.
 */

export const EVOLUS_REST_ROOT = 'https://api.evolus.ai/api/v1';
export const EVOLUS_CHAT_ROOT = 'https://api.evolus.ai/v1';

/** Documented ceilings, enforced locally so a refusal is not discovered as a 400. */
export const EVOLUS_MAX_CHARS = 120_000;
export const EVOLUS_MAX_BYTES = 20 * 1024 * 1024;
export const EVOLUS_MAX_PDF_PAGES = 60;

export const AI_TOOLS = ['doc-structure', 'tables', 'translate', 'anonymize', 'summarize', 'minutes', 'email', 'rewrite', 'simplify', 'sentiment', 'compare'] as const;
export type AiTool = (typeof AI_TOOLS)[number];

/** The only two tools with a file-in, file-out route. */
export const AI_FILE_TOOLS = ['translate', 'anonymize'] as const;
export type AiFileTool = (typeof AI_FILE_TOOLS)[number];

export const EVOLUS_ENV_VARS = [
  'EVOLUS_API_KEY',
  'EVOLUS_APP_ID',
  'EVOLUS_USER_API_KEY',
  'EVOLUS_WORKFLOW_CHANGE_ORDER',
  'EVOLUS_AGENT_ID',
  'EVOLUS_EXTRACTOR_ID',
  'EVOLUS_MEMORY_LIBRARY_ID',
  'EVOLUS_CALLBACK_BASE_URL',
  'EVOLUS_POLL_MS',
  'EVOLUS_POLL_TIMEOUT_MS',
  'EVOLUS_TIMEOUT_MS',
] as const;

export class EvolusError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, errorCode?: string, traceId?: string) {
    super(message);
    this.name = 'EvolusError';
    this.status = status;
    this.errorCode = errorCode;
    this.traceId = traceId;
  }
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function evolusApiKey(): string | undefined {
  return env('EVOLUS_API_KEY') ?? env('EVOLUS_USER_API_KEY');
}

export function evolusAppId(): string | undefined {
  return env('EVOLUS_APP_ID');
}

export function evolusConfigured(): boolean {
  return evolusApiKey() !== undefined && evolusAppId() !== undefined;
}

/** Strip any configured credential from a string that may become an error message. */
export function redact(text: string): string {
  let out = text;
  for (const name of ['EVOLUS_API_KEY', 'EVOLUS_USER_API_KEY', 'AMD_VLLM_API_KEY']) {
    const value = env(name);
    if (value && value.length > 4) out = out.split(value).join('[redacted]');
  }
  return out;
}

/** Platform headers. `X-User-ApiKey` wins when present: it attributes the call to a person. */
function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = evolusApiKey();
  if (!key) throw new EvolusError('no Evolus credential: set EVOLUS_API_KEY or EVOLUS_USER_API_KEY', 0);
  const app = evolusAppId();
  const headers: Record<string, string> = { ...extra };
  if (env('EVOLUS_USER_API_KEY')) headers['X-User-ApiKey'] = env('EVOLUS_USER_API_KEY') as string;
  else headers['X-ApiKey'] = key;
  if (app) headers['X-Application-Id'] = app;
  return headers;
}

function bearerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = evolusApiKey();
  if (!key) throw new EvolusError('no Evolus credential: set EVOLUS_API_KEY or EVOLUS_USER_API_KEY', 0);
  return { ...extra, authorization: `Bearer ${key}` };
}

export interface EvolusStatusReport {
  configured: boolean;
  /** which variables are set - names and presence only, never values */
  env: Record<string, boolean>;
  missing: string[];
  blocksUsed: ReturnType<typeof blocksUsed>;
  note: string;
}

export function evolusStatus(): EvolusStatusReport {
  const presence: Record<string, boolean> = {};
  for (const name of EVOLUS_ENV_VARS) presence[name] = env(name) !== undefined;
  const missing = EVOLUS_ENV_VARS.filter((n) => !presence[n]);
  return {
    configured: evolusConfigured(),
    env: presence,
    missing,
    blocksUsed: blocksUsed(),
    note: !evolusConfigured()
      ? 'no credential or application id: every business flow runs on its local path and is labelled as such'
      : `space ${presence.EVOLUS_APP_ID ? 'set' : 'missing'}; ${ledgerSummary().calls} calls this process, ${ledgerSummary().credits} credits; identifiers are in the ledger`,
  };
}

/**
 * Turn an Evolus failure into a message that can be quoted to their support.
 *
 * A bare "400 Bad Request" over a problem+json body that says
 * `errorCode: WORKFLOW_NOT_FOUND` is the difference between a five-minute fix and
 * an afternoon of guessing.
 */
export async function explainEvolusError(res: Response): Promise<{ message: string; errorCode?: string; traceId?: string }> {
  const raw = await res.text().catch(() => '');
  let errorCode: string | undefined;
  let traceId: string | undefined;
  let detail: string | undefined;
  const isProblem = (res.headers.get('content-type') ?? '').includes('problem+json');
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    errorCode = typeof j.errorCode === 'string' ? j.errorCode : undefined;
    traceId = typeof j.traceId === 'string' ? j.traceId : typeof j.requestId === 'string' ? j.requestId : undefined;
    detail = typeof j.detail === 'string' ? j.detail : typeof j.title === 'string' ? j.title : undefined;
  } catch {
    detail = isProblem ? undefined : raw.slice(0, 200);
  }
  traceId = traceId ?? res.headers.get('x-trace-id') ?? res.headers.get('traceparent') ?? undefined;

  const parts = [`evolus HTTP ${res.status}`];
  if (isProblem) parts.push('problem+json');
  if (errorCode) parts.push(`errorCode=${errorCode}`);
  if (traceId) parts.push(`traceId=${traceId}`);
  if (detail) parts.push(detail.replace(/\s+/g, ' ').slice(0, 200));
  return { message: redact(parts.join('; ')), errorCode, traceId };
}

export interface CallOptions {
  block: EvolusBlock;
  /** path below the documented root, e.g. `/ai-tools/summarize/run` */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: BodyInit;
  /** multipart bodies must not be given a content-type: the runtime adds the boundary */
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** agent chat lives on /v1 with bearer auth; everything else on /api/v1 with headers */
  auth?: 'rest' | 'bearer';
}

export interface EvolusCall {
  res: Response;
  /** the live ledger row; fill in body-derived identifiers on it */
  entry: LedgerEntry;
}

function urlFor(opts: CallOptions): string {
  const root = opts.auth === 'bearer' ? EVOLUS_CHAT_ROOT : EVOLUS_REST_ROOT;
  const url = new URL(`${root}${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

/**
 * One request, one ledger row.
 *
 * The row is written before the body is parsed and is handed back mutable, so a
 * caller who learns an execution id from the payload can attach it to the same
 * row that recorded the timing.
 */
export async function evolusCall(opts: CallOptions): Promise<EvolusCall> {
  const t0 = Date.now();
  const headers = opts.auth === 'bearer' ? bearerHeaders(opts.headers ?? {}) : restHeaders(opts.headers ?? {});
  const target = urlFor(opts);
  // the pathname, version prefix included: `/api/v1/ai-tools/summarize/run` is what
  // a support ticket quotes, and a query string could carry a document name
  const entry = recordLedger({ at: new Date().toISOString(), block: opts.block, endpoint: new URL(target).pathname, ms: 0, ok: false });

  let res: Response;
  try {
    res = await fetch(target, {
      method: opts.method ?? 'POST',
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? num('EVOLUS_TIMEOUT_MS', 60_000)),
    });
  } catch (e) {
    entry.ms = Date.now() - t0;
    entry.errorCode = 'transport';
    throw new EvolusError(redact(`evolus ${opts.path} unreachable: ${(e as Error).message}`), 0);
  }

  entry.ms = Date.now() - t0;
  entry.status = res.status;
  entry.ok = res.ok;
  entry.traceId = res.headers.get('x-trace-id') ?? res.headers.get('traceid') ?? undefined;
  entry.executionId = res.headers.get('x-workflow-execution-id') ?? res.headers.get('x-askfile-execution-id') ?? undefined;
  entry.jobId = res.headers.get('x-job-id') ?? undefined;
  entry.auditId = res.headers.get('x-askfile-audit-id') ?? undefined;
  entry.conversationId = res.headers.get('x-conversation-id') ?? undefined;
  const credits = res.headers.get('x-credits-consumed');
  if (credits !== null && Number.isFinite(Number(credits))) entry.creditsConsumed = Number(credits);

  if (!res.ok) {
    const explained = await explainEvolusError(res);
    entry.errorCode = explained.errorCode;
    entry.traceId = entry.traceId ?? explained.traceId;
    if (res.status === 409) throw new EvolusError(`${explained.message} (the workflow or resource is switched off)`, 409, explained.errorCode, entry.traceId);
    throw new EvolusError(explained.message, res.status, explained.errorCode, entry.traceId);
  }
  return { res, entry };
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/* --------------------------------------------------------------- workflows */

export interface EvolusFile {
  bytes: Uint8Array | ArrayBuffer | Blob;
  filename: string;
  contentType?: string;
  /** form field name; the platform expects `file` and accepts several of them */
  field?: string;
}

export interface WorkflowRequest {
  input: string;
  files?: EvolusFile[];
  /** flat JSON object, sent as a string: nested values are rejected by the platform */
  parameters?: Record<string, string | number | boolean>;
  callbackUrl?: string;
  callbackMethod?: 'POST' | 'PUT' | 'PATCH';
  callbackApiKey?: string;
  callbackApiKeyName?: string;
}

export interface WorkflowAccepted {
  jobId: string;
  executionId: string;
  enqueuedAt?: string;
  traceId?: string;
  httpStatus: number;
}

export type ExecutionStatus = 'Pending' | 'Running' | 'Completed' | 'Failed';

export interface ExecutionState {
  status: ExecutionStatus;
  workflowId: string;
  executionId: string;
  polls: number;
  output?: string;
  raw: Record<string, unknown>;
}

/**
 * `POST /workflows/{id}/execute` as multipart/form-data.
 *
 * The 202 answer is not the result; it is a receipt. The execution id arrives in
 * the body and, redundantly, in `X-Workflow-Execution-Id` - both are read because
 * stacks have been observed to omit one of them.
 */
export async function executeWorkflow(workflowId: string, req: WorkflowRequest): Promise<WorkflowAccepted> {
  if (!workflowId) throw new EvolusError('no workflow id given; set EVOLUS_WORKFLOW_CHANGE_ORDER', 0);
  const form = new FormData();
  form.append('input', req.input);
  if (req.parameters) form.append('parameters', JSON.stringify(req.parameters));
  for (const f of req.files ?? []) {
    assertWithinFileLimits(f);
    form.append(f.field ?? 'file', new Blob([f.bytes as BlobPart], { type: f.contentType ?? 'application/octet-stream' }), f.filename);
  }
  if (req.callbackUrl) form.append('callbackUrl', req.callbackUrl);
  if (req.callbackMethod) form.append('callbackMethod', req.callbackMethod);
  if (req.callbackApiKey) form.append('callbackApiKey', req.callbackApiKey);
  if (req.callbackApiKeyName) form.append('callbackApiKeyName', req.callbackApiKeyName);

  const { res, entry } = await evolusCall({
    block: 'workflow.execute',
    path: `/workflows/${encodeURIComponent(workflowId)}/execute`,
    method: 'POST',
    body: form,
  });

  const j = await jsonBody(res);
  const executionId = String(j.executionId ?? entry.executionId ?? '');
  if (!executionId) throw new EvolusError('evolus accepted the workflow but returned no execution id', res.status, undefined, entry.traceId);
  entry.executionId = executionId;
  entry.jobId = String(j.jobId ?? entry.jobId ?? '') || undefined;
  // the receipt carries the trace id in the body; headers are the fallback, not the source
  const traceId = typeof j.traceId === 'string' ? j.traceId : entry.traceId;
  entry.traceId = traceId;
  return {
    jobId: String(j.jobId ?? entry.jobId ?? ''),
    executionId,
    enqueuedAt: j.enqueuedAt ? String(j.enqueuedAt) : undefined,
    traceId,
    httpStatus: res.status,
  };
}

export async function getExecution(workflowId: string, executionId: string): Promise<ExecutionState> {
  const { res, entry } = await evolusCall({
    block: 'workflow.poll',
    path: `/workflows/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`,
    method: 'GET',
  });
  const j = await jsonBody(res);
  entry.executionId = executionId;
  return {
    status: toStatus(j.status ?? j.state),
    workflowId,
    executionId,
    polls: 1,
    output: typeof j.output === 'string' ? j.output : j.output !== undefined ? JSON.stringify(j.output) : undefined,
    raw: j,
  };
}

/**
 * Unknown status words are treated as still-running, not as failure: inventing a
 * terminal state for a string the platform has not published would end a poll
 * early and report a result that does not exist.
 */
function toStatus(value: unknown): ExecutionStatus {
  const s = String(value ?? '').toLowerCase();
  if (s.startsWith('compl')) return 'Completed';
  if (s.startsWith('fail') || s.startsWith('error') || s.startsWith('cancel')) return 'Failed';
  if (s.startsWith('run')) return 'Running';
  return 'Pending';
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onPoll?: (state: ExecutionState) => void;
}

/** Poll to a terminal state. Budget-bounded, because a stuck execution is a real state. */
export async function pollExecution(workflowId: string, executionId: string, opts: PollOptions = {}): Promise<ExecutionState> {
  const interval = opts.intervalMs ?? num('EVOLUS_POLL_MS', 3000);
  const budget = opts.timeoutMs ?? num('EVOLUS_POLL_TIMEOUT_MS', 120_000);
  const deadline = Date.now() + budget;
  let polls = 0;
  for (;;) {
    const state = await getExecution(workflowId, executionId);
    state.polls = ++polls;
    opts.onPoll?.(state);
    if (state.status === 'Completed' || state.status === 'Failed') return state;
    if (Date.now() + interval > deadline) {
      throw new EvolusError(`execution ${executionId} of workflow ${workflowId} was still ${state.status} after ${budget} ms of polling`, 408, 'POLL_TIMEOUT', state.raw.traceId ? String(state.raw.traceId) : undefined);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/* ----------------------------------------------------------------- ai tools */

export interface AiToolRun {
  tool: string;
  output: string;
  creditsConsumed: number;
  truncated: boolean;
}

function assertTool(tool: string): asserts tool is AiTool {
  if (!(AI_TOOLS as readonly string[]).includes(tool)) {
    throw new EvolusError(`"${tool}" is not an Evolus AI tool; the published set is ${AI_TOOLS.join(', ')}`, 0, 'UNKNOWN_TOOL');
  }
}

function assertWithinTextLimits(text: string): void {
  if (text.length > EVOLUS_MAX_CHARS) {
    throw new EvolusError(`input is ${text.length} characters, over the documented ${EVOLUS_MAX_CHARS} limit; it was refused before the request`, 0, 'TEXT_TOO_LARGE');
  }
}

function assertWithinFileLimits(file: EvolusFile): void {
  const size = file.bytes instanceof Blob ? file.bytes.size : (file.bytes as ArrayBuffer | Uint8Array).byteLength;
  if (size > EVOLUS_MAX_BYTES) {
    throw new EvolusError(`${file.filename} is ${size} bytes, over the documented 20 MB document limit`, 0, 'FILE_TOO_LARGE');
  }
}

function toRun(tool: string, j: Record<string, unknown>, entry: LedgerEntry): AiToolRun {
  const out = j.output;
  if (typeof j.creditsConsumed === 'number') entry.creditsConsumed = j.creditsConsumed;
  return {
    tool: String(j.tool ?? tool),
    output: typeof out === 'string' ? out : out === undefined ? '' : JSON.stringify(out, null, 2),
    creditsConsumed: typeof j.creditsConsumed === 'number' ? j.creditsConsumed : entry.creditsConsumed ?? 0,
    truncated: j.truncated === true,
  };
}

export async function listAiTools(): Promise<unknown> {
  const { res } = await evolusCall({ block: 'ai-tools.list', path: '/ai-tools', method: 'GET' });
  return jsonBody(res);
}

export async function runAiTool(
  tool: AiTool,
  text: string,
  opts: { secondaryText?: string; options?: Record<string, unknown> } = {},
): Promise<AiToolRun> {
  assertTool(tool);
  assertWithinTextLimits(text);
  const { res, entry } = await evolusCall({
    block: 'ai-tools.run',
    path: `/ai-tools/${tool}/run`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(opts.secondaryText !== undefined ? { secondaryText: opts.secondaryText } : {}), ...(opts.options ? { options: opts.options } : {}) }),
  });
  return toRun(tool, await jsonBody(res), entry);
}

/**
 * File in, text out. `options` travels as a JSON query parameter, which is the
 * part of the contract that a JSON-first implementation always gets wrong.
 */
export async function runAiToolMedia(tool: AiTool, file: EvolusFile, options?: Record<string, unknown>): Promise<AiToolRun> {
  assertTool(tool);
  assertWithinFileLimits(file);
  const form = new FormData();
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.contentType ?? 'application/octet-stream' }), file.filename);
  const { res, entry } = await evolusCall({
    block: 'ai-tools.run-media',
    path: `/ai-tools/${tool}/run-media`,
    method: 'POST',
    body: form,
    ...(options ? { query: { options: JSON.stringify(options) } } : {}),
  });
  return toRun(tool, await jsonBody(res), entry);
}

/**
 * File in, file out, `translate` and `anonymize` only.
 *
 * Credits are billed in the response header here, not in the body, and the body
 * is the converted document, so nothing is parsed as JSON.
 */
export async function runAiToolFile(
  tool: AiFileTool,
  file: EvolusFile,
  options?: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; filename: string; contentType: string; creditsConsumed: number }> {
  if (!(AI_FILE_TOOLS as readonly string[]).includes(tool)) {
    throw new EvolusError(`run-file is published only for ${AI_FILE_TOOLS.join(' and ')}; "${tool}" has no file route`, 0, 'UNSUPPORTED_ROUTE');
  }
  assertWithinFileLimits(file);
  const form = new FormData();
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.contentType ?? 'application/octet-stream' }), file.filename);
  const { res, entry } = await evolusCall({
    block: 'ai-tools.run-file',
    path: `/ai-tools/${tool}/run-file`,
    method: 'POST',
    body: form,
    ...(options ? { query: { options: JSON.stringify(options) } } : {}),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const credits = Number(res.headers.get('x-credits-consumed') ?? '0');
  if (Number.isFinite(credits)) entry.creditsConsumed = credits;
  return { bytes, filename: `converted-${file.filename}`, contentType: res.headers.get('content-type') ?? 'application/octet-stream', creditsConsumed: Number.isFinite(credits) ? credits : 0 };
}

/* ------------------------------------------------------- document extractors */

export type ExtractorMode = 'json' | 'csv' | 'text';

export interface AskFileResult {
  /** the response body is the data: there is no envelope to unwrap */
  data: string;
  parsed: unknown | null;
  executionId?: string;
  auditId?: string;
  contentType: string;
}

/**
 * Synchronous extraction against a published agent's extractor.
 *
 * Extra form fields are context for the extractor, so a procedure document can be
 * told which tank number to look for without retraining anything.
 */
export async function askFileExtractor(
  agentId: string,
  mode: ExtractorMode,
  extractorId: string,
  file: EvolusFile,
  context: Record<string, string> = {},
): Promise<AskFileResult> {
  if (!agentId || !extractorId) throw new EvolusError('no extractor configured; set EVOLUS_AGENT_ID and EVOLUS_EXTRACTOR_ID', 0, 'NOT_CONFIGURED');
  assertWithinFileLimits(file);
  const form = new FormData();
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.contentType ?? 'application/octet-stream' }), file.filename);
  for (const [k, v] of Object.entries(context)) form.append(k, v);

  const { res, entry } = await evolusCall({
    block: 'extractors.ask-file',
    path: `/agents/${encodeURIComponent(agentId)}/${mode}/${encodeURIComponent(extractorId)}/ask-file`,
    method: 'POST',
    body: form,
  });
  const data = await res.text();
  let parsed: unknown | null = null;
  if (mode === 'json') {
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { data, parsed, executionId: entry.executionId, auditId: entry.auditId, contentType: res.headers.get('content-type') ?? 'text/plain' };
}

/* -------------------------------------------------------- knowledge library */

export async function uploadMemoryDocument(libraryId: string, file: EvolusFile, extra: Record<string, string> = {}): Promise<Record<string, unknown>> {
  assertWithinFileLimits(file);
  const form = new FormData();
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.contentType ?? 'application/octet-stream' }), file.filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const { res } = await evolusCall({ block: 'memories.upload', path: `/memories/${encodeURIComponent(libraryId)}/documents`, method: 'POST', body: form });
  return jsonBody(res);
}

export async function importMemoryUrl(libraryId: string, url: string): Promise<Record<string, unknown>> {
  const { res } = await evolusCall({
    block: 'memories.import-url',
    path: `/memories/${encodeURIComponent(libraryId)}/documents/import-url`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return jsonBody(res);
}

export async function memoryDocumentFormats(): Promise<unknown> {
  const { res } = await evolusCall({ block: 'memories.formats', path: '/memories/document-formats', method: 'GET' });
  return jsonBody(res);
}

/* ------------------------------------------------------ agent chat, OpenAI-ish */

/** Model id is `<applicationId>:<agentId>`; nothing else resolves on this base. */
export function agentModelId(agentId: string): string {
  const app = evolusAppId();
  if (!app) throw new EvolusError('EVOLUS_APP_ID is not set, so no agent model id can be formed', 0, 'NOT_CONFIGURED');
  return `${app}:${agentId}`;
}

export interface AgentChatOptions {
  agentId?: string;
  conversationId?: string;
  history?: ChatMessage[];
  timeoutMs?: number;
}

export interface AgentChatResult {
  text: string;
  conversationId?: string;
  model: string;
  ms: number;
}

function chatBody(model: string, messages: ChatMessage[], stream: boolean): string {
  // `temperature` is ignored by the platform and is not sent: an option that does
  // nothing in a request body is how an integration comes to be mistrusted
  return JSON.stringify({ model, messages, stream });
}

function chatHeaders(conversationId?: string): Record<string, string> {
  return { 'content-type': 'application/json', ...(conversationId ? { 'X-Conversation-Id': conversationId } : {}) };
}

export async function agentChat(question: string, opts: AgentChatOptions = {}): Promise<AgentChatResult> {
  const agentId = opts.agentId ?? env('EVOLUS_AGENT_ID');
  if (!agentId) throw new EvolusError('EVOLUS_AGENT_ID is not set, so there is no agent to ask', 0, 'NOT_CONFIGURED');
  const model = agentModelId(agentId);
  const t0 = Date.now();
  const { res, entry } = await evolusCall({
    block: 'agent.chat',
    path: '/chat/completions',
    method: 'POST',
    auth: 'bearer',
    headers: chatHeaders(opts.conversationId),
    body: chatBody(model, [...(opts.history ?? []), { role: 'user', content: question }], false),
    timeoutMs: opts.timeoutMs,
  });
  const j = await jsonBody(res);
  const choices = Array.isArray(j.choices) ? (j.choices as Record<string, unknown>[]) : [];
  const message = choices[0]?.message as { content?: unknown } | undefined;
  entry.conversationId = entry.conversationId ?? (typeof j.conversationId === 'string' ? j.conversationId : undefined);
  return {
    text: typeof message?.content === 'string' ? message.content : '',
    conversationId: entry.conversationId,
    model: String(j.model ?? model),
    ms: Date.now() - t0,
  };
}

/**
 * Streaming variant: the platform's SSE is forwarded to the caller, which owns
 * the response. The conversation id has to be read before the body is handed on,
 * because once it is a stream the headers are gone.
 */
export async function agentChatStream(question: string, opts: AgentChatOptions = {}): Promise<{ res: Response; conversationId?: string; model: string }> {
  const agentId = opts.agentId ?? env('EVOLUS_AGENT_ID');
  if (!agentId) throw new EvolusError('EVOLUS_AGENT_ID is not set, so there is no agent to ask', 0, 'NOT_CONFIGURED');
  const model = agentModelId(agentId);
  const { res, entry } = await evolusCall({
    block: 'agent.chat.stream',
    path: '/chat/completions',
    method: 'POST',
    auth: 'bearer',
    headers: chatHeaders(opts.conversationId),
    body: chatBody(model, [...(opts.history ?? []), { role: 'user', content: question }], true),
    timeoutMs: opts.timeoutMs,
  });
  return { res, conversationId: entry.conversationId, model };
}

export async function listAgentModels(): Promise<string[]> {
  const { res } = await evolusCall({ block: 'agent.models', path: '/models', method: 'GET', auth: 'bearer' });
  const j = await jsonBody(res);
  const data = Array.isArray(j.data) ? (j.data as Record<string, unknown>[]) : [];
  return data.map((d) => String(d.id ?? '')).filter(Boolean);
}
