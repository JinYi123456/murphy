import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_TOOLS, EvolusError, explainEvolusError, executeWorkflow, getExecution, agentChat, askFileExtractor,
  evolusStatus, pollExecution, runAiTool, runAiToolFile, runAiToolMedia,
} from '../src/lib/evolus/client';
import { ledgerSummary, readLedger, resetLedger } from '../src/lib/evolus/ledger';
import { askKnowledge, intakeProcedure, localDiff, routeChangeOrder } from '../src/lib/evolus/workflows';
import { PROCEDURES } from '../src/lib/registry';
import { GET as statusRoute } from '../src/app/api/evolus/status/route';
import { POST as intakeRoute } from '../src/app/api/evolus/intake/route';
import { POST as changeOrderRoute } from '../src/app/api/evolus/change-order/route';
import { POST as askRoute } from '../src/app/api/evolus/ask/route';

/**
 * These tests hold the integration to the published contract: the 202 receipt and
 * the poll, the multipart bodies that must not be JSON, the credit headers that
 * are the only billing signal available, and the identifiers that make a claim
 * checkable by somebody who is not us.
 */

const KEY = 'evolus-secret-DO-NOT-LEAK';
const EVOLUS_ENV = ['EVOLUS_API_KEY', 'EVOLUS_APP_ID', 'EVOLUS_USER_API_KEY', 'EVOLUS_WORKFLOW_CHANGE_ORDER', 'EVOLUS_AGENT_ID', 'EVOLUS_EXTRACTOR_ID', 'EVOLUS_MEMORY_LIBRARY_ID', 'EVOLUS_POLL_MS', 'EVOLUS_POLL_TIMEOUT_MS', 'EVOLUS_TIMEOUT_MS'];
const SOP = readFileSync('data/sop/OP-TRF-014.md', 'utf8');

interface Seen {
  url: string;
  init: RequestInit;
}

function clearEnv(): void {
  for (const name of EVOLUS_ENV) delete process.env[name];
}

function connect(): void {
  process.env.EVOLUS_API_KEY = KEY;
  process.env.EVOLUS_APP_ID = 'space-77';
  process.env.EVOLUS_POLL_MS = '1';
  process.env.EVOLUS_POLL_TIMEOUT_MS = '2000';
}

function fakeEvolus(reply: (seen: Seen) => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit) => {
    const s = { url: String(url), init };
    seen.push(s);
    return reply(s);
  }));
  return seen;
}

function body(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function problem(status: number, detail: Record<string, unknown>): Response {
  return new Response(JSON.stringify(detail), { status, headers: { 'content-type': 'application/problem+json' } });
}

/** Re-read a request body as the multipart form the platform must receive. */
async function asForm(seen: Seen): Promise<{ contentType: string | null; form: FormData }> {
  const req = new Request(seen.url, { method: 'POST', body: seen.init.body as BodyInit });
  return { contentType: req.headers.get('content-type'), form: await req.formData() };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearEnv();
  resetLedger();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEnv();
  resetLedger();
});

describe('workflow execution', () => {
  it('executes as multipart/form-data and reads the 202 receipt', async () => {
    connect();
    const seen = fakeEvolus(() => body({ jobId: 'job-1', executionId: 'exe-9', enqueuedAt: '2026-10-15T09:00:00Z', traceId: 'tr-3' }, 202, { 'X-Workflow-Execution-Id': 'exe-9' }));

    const accepted = await executeWorkflow('wf-42', {
      input: 'approve this change order',
      files: [{ bytes: new TextEncoder().encode('# MOC\nbody'), filename: 'change-order.md', contentType: 'text/markdown' }],
      parameters: { procedure: 'OP-TRF-014', risk_pct: '0.20' },
      callbackMethod: 'POST',
      callbackUrl: 'https://murphy.test/api/evolus/callback',
    });

    expect(accepted).toMatchObject({ jobId: 'job-1', executionId: 'exe-9', traceId: 'tr-3', httpStatus: 202 });
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/workflows/wf-42/execute');
    expect(seen[0].init.method).toBe('POST');
    // an explicit content-type would break the boundary the runtime generates
    expect(Object.keys(seen[0].init.headers as Record<string, string>)).not.toContain('content-type');
    expect(seen[0].init.headers).toMatchObject({ 'X-ApiKey': KEY, 'X-Application-Id': 'space-77' });

    const { contentType, form } = await asForm(seen[0]);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0].init.body).toBeInstanceOf(FormData);
    expect(form.get('input')).toBe('approve this change order');
    expect(JSON.parse(String(form.get('parameters')))).toEqual({ procedure: 'OP-TRF-014', risk_pct: '0.20' });
    expect(form.get('callbackMethod')).toBe('POST');
    const file = form.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('change-order.md');
    expect(await file.text()).toBe('# MOC\nbody');
  });

  it('polls Pending, Running, then stops at Completed', async () => {
    connect();
    let n = 0;
    const seen = fakeEvolus(() => {
      n++;
      const status = ['Pending', 'Running', 'Completed'][Math.min(n - 1, 2)];
      return body({ status, executionId: 'exe-9', output: status === 'Completed' ? 'approved' : null });
    });

    const first = await getExecution('wf-42', 'exe-9');
    expect(first.status).toBe('Pending');
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/workflows/wf-42/executions/exe-9');
    expect(seen[0].init.method).toBe('GET');

    n = 0;
    const done = await pollExecution('wf-42', 'exe-9');
    expect(done.status).toBe('Completed');
    expect(done.polls).toBe(3);
    expect(done.output).toBe('approved');
  });

  it('reports a switched-off workflow as 409 with the platform error code', async () => {
    connect();
    fakeEvolus(() => problem(409, { type: 'https://api.evolus.ai/problems/workflow-disabled', title: 'Workflow Disabled', status: 409, detail: 'the workflow is switched off', errorCode: 'WORKFLOW_DISABLED', traceId: 'tr-409' }));

    await expect(executeWorkflow('wf-off', { input: 'x' })).rejects.toMatchObject({
      status: 409,
      errorCode: 'WORKFLOW_DISABLED',
      traceId: 'tr-409',
    });
    await expect(executeWorkflow('wf-off', { input: 'x' })).rejects.toThrow(/WORKFLOW_DISABLED.*switched off/s);
  });

  it('gives up on a stuck execution instead of polling forever', async () => {
    connect();
    process.env.EVOLUS_POLL_TIMEOUT_MS = '5';
    fakeEvolus(() => body({ status: 'Running' }));
    await expect(pollExecution('wf-42', 'exe-9', { intervalMs: 2 })).rejects.toThrow(/still Running after 5 ms/);
  });

  it('surfaces problem+json identifiers, and refuses text it cannot carry', async () => {
    connect();
    const explained = await explainEvolusError(problem(422, { detail: 'pdf exceeds 60 pages', errorCode: 'DOC_TOO_LONG', traceId: 'tr-7' }));
    expect(explained.errorCode).toBe('DOC_TOO_LONG');
    expect(explained.traceId).toBe('tr-7');
    expect(explained.message).toContain('problem+json');
    expect(explained.message).toContain('60 pages');

    fakeEvolus(() => body({ tool: 'summarize', output: 'ok' }));
    await expect(runAiTool('summarize', 'x'.repeat(120_001))).rejects.toThrow(/120000/);

    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(runAiTool('not-a-tool' as never, 'hello')).rejects.toThrow(/not an Evolus AI tool/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AI tools', () => {
  it('runs a tool as JSON and takes the credits from the body', async () => {
    connect();
    const seen = fakeEvolus(() => body({ tool: 'compare', output: 'three fields differ', creditsConsumed: 4, truncated: true }));
    const run = await runAiTool('compare', 'ours', { secondaryText: 'theirs', options: { mode: 'field-level' } });
    expect(run).toMatchObject({ tool: 'compare', output: 'three fields differ', creditsConsumed: 4, truncated: true });
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/ai-tools/compare/run');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ text: 'ours', secondaryText: 'theirs', options: { mode: 'field-level' } });
  });

  it('sends run-media as multipart with options in the query string', async () => {
    connect();
    const seen = fakeEvolus(() => body({ tool: 'doc-structure', output: '{"pages":3}', creditsConsumed: 2, truncated: false }));
    const run = await runAiToolMedia('doc-structure', { bytes: new TextEncoder().encode('doc'), filename: 'a.pdf', contentType: 'application/pdf' }, { pages: 'all' });
    expect(run.creditsConsumed).toBe(2);
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe('/api/v1/ai-tools/doc-structure/run-media');
    expect(JSON.parse(url.searchParams.get('options') as string)).toEqual({ pages: 'all' });
    const { contentType, form } = await asForm(seen[0]);
    expect(contentType).toMatch(/^multipart\/form-data/);
    expect((form.get('file') as File).name).toBe('a.pdf');
  });

  it('reads run-file credits from the X-Credits-Consumed header', async () => {
    connect();
    const seen = fakeEvolus(() => new Response(new Uint8Array([77, 79, 67]), { status: 200, headers: { 'content-type': 'text/markdown', 'X-Credits-Consumed': '7.5' } }));
    const out = await runAiToolFile('anonymize', { bytes: new TextEncoder().encode('Operator J. Murphy said so'), filename: 'moc.md' });
    expect(out.creditsConsumed).toBe(7.5);
    expect(Array.from(out.bytes)).toEqual([77, 79, 67]);
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/ai-tools/anonymize/run-file');
    const { form } = await asForm(seen[0]);
    expect(form.get('file')).toBeInstanceOf(Blob);

    await expect(runAiToolFile('summarize' as never, { bytes: new Uint8Array(1), filename: 'x' })).rejects.toThrow(/run-file is published only for/);
  });

  it('lists the published tools', () => {
    expect(AI_TOOLS).toHaveLength(11);
    expect(AI_TOOLS).toContain('doc-structure');
    expect(AI_TOOLS).toContain('compare');
  });
});

describe('extractors and agent chat', () => {
  it('asks a file extractor with context fields and returns the raw body', async () => {
    connect();
    const seen = fakeEvolus(() => new Response('{"document":"OP-TRF-014","steps":["open V1"]}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'X-AskFile-Execution-Id': 'af-exe-1', 'X-AskFile-Audit-Id': 'af-audit-1' },
    }));
    const asked = await askFileExtractor('ag-3', 'json', 'ex-9', { bytes: new TextEncoder().encode(SOP), filename: 'OP-TRF-014.md' }, { procedure_id: 'OP-TRF-014' });

    expect(asked.executionId).toBe('af-exe-1');
    expect(asked.auditId).toBe('af-audit-1');
    expect(asked.parsed).toMatchObject({ document: 'OP-TRF-014' });
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/agents/ag-3/json/ex-9/ask-file');
    const { contentType, form } = await asForm(seen[0]);
    expect(contentType).toMatch(/^multipart\/form-data/);
    expect(form.get('procedure_id')).toBe('OP-TRF-014');
    expect((form.get('file') as File).name).toBe('OP-TRF-014.md');
  });

  it('uses the <applicationId>:<agentId> model, bearer auth, and continues by conversation id', async () => {
    connect();
    process.env.EVOLUS_AGENT_ID = 'ag-3';
    let n = 0;
    const seen = fakeEvolus(() => {
      n++;
      return body({ choices: [{ message: { content: n === 1 ? 'Per rev 7, stop at 9.30 m.' : 'The vent was isolated for the roof campaign.' } }] }, 200, { 'X-Conversation-Id': 'conv-55' });
    });

    const first = await agentChat('when do we stop the pump?');
    expect(first.conversationId).toBe('conv-55');
    expect(seen[0].url).toBe('https://api.evolus.ai/v1/chat/completions');
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ model: 'space-77:ag-3', stream: false });
    expect(JSON.parse(String(seen[0].init.body))).not.toHaveProperty('temperature');
    expect(seen[0].init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(seen[0].init.headers).not.toHaveProperty('X-ApiKey');

    const next = await agentChat('what about the vent?', { conversationId: first.conversationId });
    expect(next.text).toContain('roof');
    expect(seen[1].init.headers).toMatchObject({ 'X-Conversation-Id': 'conv-55' });
  });

  it('refuses to invent a model id without a space', async () => {
    connect();
    delete process.env.EVOLUS_APP_ID;
    process.env.EVOLUS_AGENT_ID = 'ag-3';
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(agentChat('anything')).rejects.toThrow(/EVOLUS_APP_ID is not set/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ledger', () => {
  it('records one row per call, with identifiers and credits, and no payload', async () => {
    connect();
    fakeEvolus((s) => (s.url.endsWith('/run') ? body({ tool: 'summarize', output: 'a digest that must not be stored', creditsConsumed: 3 }) : body({ status: 'Completed' })));

    await runAiTool('summarize', 'change order text with an operator name in it');
    await getExecution('wf-42', 'exe-9');

    const rows = readLedger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ block: 'ai-tools.run', endpoint: '/api/v1/ai-tools/summarize/run', ok: true, creditsConsumed: 3 });
    expect(rows[0].ms).toBeGreaterThanOrEqual(0);
    expect(rows[1]).toMatchObject({ block: 'workflow.poll', ok: true, executionId: 'exe-9' });
    expect(JSON.stringify(rows)).not.toContain('operator name');
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(ledgerSummary()).toMatchObject({ calls: 2, failed: 0, credits: 3 });
  });

  it('counts a failure as a failure', async () => {
    connect();
    fakeEvolus(() => problem(429, { detail: 'rate limit', errorCode: 'RATE_LIMITED', traceId: 'tr-rl' }));
    await expect(runAiTool('email', 'x')).rejects.toThrow(EvolusError);
    const rows = readLedger();
    expect(rows[0]).toMatchObject({ ok: false, status: 429, errorCode: 'RATE_LIMITED', traceId: 'tr-rl' });
    expect(ledgerSummary().failed).toBe(1);
  });
});

describe('business flows', () => {
  it('intake diffs the document locally and records which path ran', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const result = await intakeProcedure(new TextEncoder().encode(SOP), 'OP-TRF-014.md');
    expect(result.path).toBe('local');
    expect(spy).not.toHaveBeenCalled();
    expect(result.fields.some((f) => f.field === 'document id' && f.status === 'match')).toBe(true);
    expect(result.fields.some((f) => f.status === 'only_ours')).toBe(true);
    expect(result.stages.every((s) => s.ok === false && s.skipped)).toBe(true);
    expect(result.note).toContain('no Evolus block ran');
  });

  it('intake uses the extractor then compare when both are configured', async () => {
    connect();
    process.env.EVOLUS_AGENT_ID = 'ag-3';
    process.env.EVOLUS_EXTRACTOR_ID = 'ex-9';
    const seen = fakeEvolus((s) => (s.url.includes('/ask-file')
      ? new Response('{"document":"OP-TRF-014"}', { headers: { 'content-type': 'application/json', 'X-AskFile-Execution-Id': 'af-1', 'X-AskFile-Audit-Id': 'au-1' } })
      : body({ tool: 'compare', output: 'rev 8 adds a step', creditsConsumed: 2 })));

    const result = await intakeProcedure(new TextEncoder().encode(SOP), 'OP-TRF-014.md');
    expect(result.path).toBe('ask-file');
    expect(result.platformDiff).toContain('rev 8');
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.evolus.ai/api/v1/agents/ag-3/json/ex-9/ask-file',
      'https://api.evolus.ai/api/v1/ai-tools/compare/run',
    ]);
    expect(result.stages.map((s) => s.block)).toEqual(['extractors.ask-file', 'ai-tools.compare']);
    expect(result.stages[0].auditId).toBe('au-1');
  });

  it('intake falls back to doc-structure for a text document', async () => {
    connect();
    const seen = fakeEvolus(() => body({ tool: 'doc-structure', output: '{"headings":["Line-up"]}', creditsConsumed: 1 }));
    const result = await intakeProcedure(new TextEncoder().encode(SOP), 'OP-TRF-014.md');
    expect(result.path).toBe('doc-structure');
    expect(seen[0].url).toBe('https://api.evolus.ai/api/v1/ai-tools/doc-structure/run');
  });

  it('routes a change order through anonymize, summarize and the approval workflow', async () => {
    connect();
    process.env.EVOLUS_WORKFLOW_CHANGE_ORDER = 'wf-42';
    let executions = 0;
    const seen = fakeEvolus((s) => {
      if (s.url.endsWith('/anonymize/run')) return body({ tool: 'anonymize', output: 'OPERATOR [NAME] said so', creditsConsumed: 2 });
      if (s.url.endsWith('/summarize/run')) return body({ tool: 'summarize', output: 'A keyed interlock removes the wrong-target mode.', creditsConsumed: 3 });
      if (s.url.endsWith('/execute')) return body({ jobId: 'job-8', executionId: 'exe-8', traceId: 'tr-8' }, 202, { 'X-Workflow-Execution-Id': 'exe-8' });
      executions++;
      return body({ status: executions >= 2 ? 'Completed' : 'Running', output: 'routed' });
    });

    const result = await routeChangeOrder({ markdown: '# MOC\nOperator J. Murphy keyed the valve.', author: 'model' });
    expect(result.path).toBe('evolus');
    expect(result.status).toBe('Completed');
    expect(result.executionId).toBe('exe-8');
    expect(result.jobId).toBe('job-8');
    expect(result.creditsConsumed).toBe(5);
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.evolus.ai/api/v1/ai-tools/anonymize/run',
      'https://api.evolus.ai/api/v1/ai-tools/summarize/run',
      'https://api.evolus.ai/api/v1/workflows/wf-42/execute',
      'https://api.evolus.ai/api/v1/workflows/wf-42/executions/exe-8',
      'https://api.evolus.ai/api/v1/workflows/wf-42/executions/exe-8',
    ]);
    expect(seen[1].init.body).not.toContain('Murphy');

    const { form } = await asForm(seen[2]);
    expect((form.get('file') as File).name).toBe('change-order.md');
    expect(await (form.get('file') as File).text()).toBe('OPERATOR [NAME] said so');
    expect(await (form.get('file') as File).text()).not.toContain('Murphy');
    expect(JSON.parse(String(form.get('parameters'))).drafted_by).toBe('model');
  });

  it('uses the file route for an attached document and keeps the original out of the ledger', async () => {
    connect();
    process.env.EVOLUS_WORKFLOW_CHANGE_ORDER = 'wf-42';
    const seen = fakeEvolus((s) => (s.url.includes('/anonymize/run-file')
      ? new Response(new TextEncoder().encode('anonymised body'), { headers: { 'content-type': 'text/markdown', 'X-Credits-Consumed': '6' } })
      : s.url.endsWith('/summarize/run')
        ? body({ tool: 'summarize', output: 'short', creditsConsumed: 1 })
        : s.url.endsWith('/execute')
          ? body({ jobId: 'j', executionId: 'e', traceId: 't' }, 202)
          : body({ status: 'Completed' })));

    const result = await routeChangeOrder({
      markdown: 'anonymised body',
      file: { bytes: new TextEncoder().encode('Operator J. Murphy keyed the valve'), filename: 'moc.md' },
    });
    expect(result.creditsConsumed).toBe(7);
    // options travel as a JSON query parameter on the file routes, never in the body
    expect(new URL(seen[0].url).pathname).toBe('/api/v1/ai-tools/anonymize/run-file');
    expect(JSON.parse(new URL(seen[0].url).searchParams.get('options') as string)).toEqual({ keep: 'device tags' });
    expect(JSON.stringify(readLedger())).not.toContain('Murphy');
  });

  it('a switched-off approval workflow is reported, not swallowed', async () => {
    connect();
    process.env.EVOLUS_WORKFLOW_CHANGE_ORDER = 'wf-off';
    fakeEvolus((s) => (s.url.endsWith('/run')
      ? body({ tool: 'summarize', output: 'digest', creditsConsumed: 1 })
      : problem(409, { detail: 'the workflow is switched off', errorCode: 'WORKFLOW_DISABLED', traceId: 'tr-409' })));

    const result = await routeChangeOrder({ markdown: '# MOC\ncontent' });
    expect(result.path).toBe('partial');
    const failed = result.stages.find((s) => s.block === 'workflow.execute');
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain('WORKFLOW_DISABLED');
    expect(failed?.error).toContain('tr-409');
    expect(result.note).toContain('routing failed');
  });

  it('with nothing configured, all three flows still answer', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const routed = await routeChangeOrder({ markdown: '# MOC' });
    const asked = await askKnowledge({ question: 'what happens if the level keeps rising after the pump stops?' });

    expect(routed.path).toBe('local');
    expect(routed.stages.every((s) => s.skipped)).toBe(true);
    expect(asked.path).toBe('local');
    expect(asked.answer).toContain('compiled model');
    expect(asked.citations.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('diffs a revised document against the model in force', () => {
    const revised = SOP.replace('**Revision:** 7', '**Revision:** 8').replace('Open the tank inlet valve **V1** on TK-101.', 'Open the tank inlet valve V1 on TK-103.');
    const fields = localDiff(revised);
    expect(fields.find((f) => f.field === 'revision')).toMatchObject({ ours: '7', document: '8', status: 'differs' });
    expect(fields.some((f) => f.status === 'only_ours')).toBe(true);
    expect(PROCEDURES[0].revision).toBe('7');
  });
});

describe('evolus routes', () => {
  const KEY_SENTINEL = `${KEY}`;

  function jsonPost(path: string, value: unknown): Request {
    return new Request(`http://murphy.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  }

  it('status reports presence by name and the ledger, never a value', async () => {
    connect();
    process.env.EVOLUS_AGENT_ID = 'ag-3';
    fakeEvolus(() => body({ tool: 'summarize', output: 'x', creditsConsumed: 1 }));
    await runAiTool('summarize', 'text');

    const res = await statusRoute();
    const text = await res.text();
    expect(text).not.toContain(KEY_SENTINEL);
    const json = JSON.parse(text) as { configured: boolean; env: Record<string, boolean>; blocksUsed: { block: string; calls: number }[] };
    expect(json.configured).toBe(true);
    expect(json.env.EVOLUS_API_KEY).toBe(true);
    expect(json.env.EVOLUS_USER_API_KEY).toBe(false);
    expect(json.blocksUsed[0]).toMatchObject({ block: 'ai-tools.run', calls: 1 });
    expect(text).toContain('/api/v1/ai-tools/summarize/run');
    expect(evolusStatus().note).not.toContain(KEY);
  });

  it('intake passes a multipart upload through and leaks nothing', async () => {
    const form = new FormData();
    form.append('document', new File([SOP], 'OP-TRF-014.md', { type: 'text/markdown' }));
    const res = await intakeRoute(new Request('http://murphy.test/api/evolus/intake', { method: 'POST', body: form }));
    const json = await res.json();
    expect(json.filename).toBe('OP-TRF-014.md');
    expect(json.path).toBe('local');
    expect(json.fields.length).toBeGreaterThan(5);
    expect(JSON.stringify(json)).not.toContain(KEY_SENTINEL);

    const missing = await intakeRoute(jsonPost('/api/evolus/intake', {}));
    expect(missing.status).toBe(400);
  });

  it('change-order and ask answer offline, and ask streams SSE when asked to', async () => {
    // a credential without a space id is not a configured integration
    process.env.EVOLUS_API_KEY = KEY;
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const order = await changeOrderRoute(jsonPost('/api/evolus/change-order', { markdown: '# MOC\nfailure fell by some points' }));
    const orderText = await order.text();
    expect(orderText).not.toContain(KEY_SENTINEL);
    expect(JSON.parse(orderText)).toMatchObject({ path: 'local' });

    const refused = await changeOrderRoute(jsonPost('/api/evolus/change-order', {}));
    expect(refused.status).toBe(400);

    const plain = await askRoute(jsonPost('/api/evolus/ask', { question: 'when must the pump be stopped?' }));
    const plainJson = await plain.json();
    expect(plainJson.path).toBe('local');
    expect(plainJson.answer).toContain('step');
    expect(JSON.stringify(plainJson)).not.toContain(KEY_SENTINEL);

    const noQuestion = await askRoute(jsonPost('/api/evolus/ask', {}));
    expect(noQuestion.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('the streaming answer is real SSE and names the path that produced it', async () => {
    connect();
    const res = await askRoute(new Request('http://murphy.test/api/evolus/ask?stream=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'what did the last incident show?' }),
    }));
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-evolus-path')).toBe('local');
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('event: done');
    expect(text).not.toContain(KEY_SENTINEL);
  });

  it('the streaming answer forwards a real agent stream and its conversation id', async () => {
    connect();
    process.env.EVOLUS_AGENT_ID = 'ag-3';
    fakeEvolus(() => new Response('data: {"choices":[{"delta":{"content":"From rev 7, stop at 9.30 m"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'X-Conversation-Id': 'conv-88' },
    }));

    const res = await askRoute(new Request('http://murphy.test/api/evolus/ask?stream=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'when must the pump be stopped?' }),
    }));
    expect(res.headers.get('x-evolus-path')).toBe('agent-chat');
    expect(res.headers.get('x-conversation-id')).toBe('conv-88');
    const text = await res.text();
    expect(text).toContain('stop at 9.30 m');
    expect(text).toContain('"path":"agent-chat"');
    expect(text).not.toContain(KEY_SENTINEL);
  });
});
