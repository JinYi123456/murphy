import {
  agentChat, agentChatStream, askFileExtractor, executeWorkflow, evolusConfigured, pollExecution,
  runAiTool, runAiToolFile, runAiToolMedia, EvolusError, type AiToolRun, type EvolusFile, type ExecutionStatus,
} from './client';
import { PROCEDURES, CONTROL_CATALOGUE } from '../registry';
import type { ChangeOrderFacts } from '../llm/agents';

/**
 * The three business flows the product actually triggers.
 *
 * Each is built from more than one Evolus block, because a single call is not a
 * workflow - it is a function call with a bill attached. What makes them flows is
 * that the output of one block decides the input of the next, and the identifiers
 * of all of them end up in the same record.
 *
 * Every flow has a local path. A demo without a platform key, or a platform that
 * is having an afternoon, still returns a field-level diff, a stillborn routing
 * record, and an answer from the compiled model - and each one says which path ran,
 * because a silent downgrade is indistinguishable from a lie.
 */

export interface FlowStage {
  block: string;
  ok: boolean;
  detail?: string;
  /** why this stage did not run, whenever it did not */
  skipped?: string;
  error?: string;
  errorCode?: string;
  traceId?: string;
  executionId?: string;
  jobId?: string;
  auditId?: string;
  conversationId?: string;
  creditsConsumed?: number;
}

function stageFromRun(block: string, run: AiToolRun): FlowStage {
  return { block, ok: true, detail: `${run.output.slice(0, 160)}${run.output.length > 160 ? '...' : ''}`, creditsConsumed: run.creditsConsumed };
}

function stageFailed(block: string, e: unknown): FlowStage {
  const err = e as EvolusError;
  return { block, ok: false, error: err.message ?? String(e), errorCode: err.errorCode, traceId: err.traceId };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function isTextDocument(filename: string): boolean {
  return /\.(md|markdown|txt|csv|json|log)$/i.test(filename);
}

/* ------------------------------------------------- 1) procedure intake, field diff */

export interface DiffField {
  field: string;
  ours: string;
  document: string;
  status: 'match' | 'differs' | 'only_ours' | 'only_document';
}

export interface IntakeResult {
  filename: string;
  /** which of the three possible extraction paths actually ran */
  path: 'ask-file' | 'doc-structure' | 'local';
  procedureId: string;
  fields: DiffField[];
  summary: string;
  /** the platform's own words on the difference, when `compare` ran */
  platformDiff?: string;
  stages: FlowStage[];
  note: string;
}

/**
 * Intake of a controlled document against the compiled model in force.
 *
 * Order of preference is order of information: a published extractor gives typed
 * fields, `doc-structure` gives a skeleton, and neither gives a diff - so the diff
 * is computed locally from whatever the platform returned. The comparison step is
 * not decoration: the platform's own `compare` tool is what turns two structures
 * into a sentence a document controller can act on.
 */
export async function intakeProcedure(documentBytes: Uint8Array, filename: string): Promise<IntakeResult> {
  const stages: FlowStage[] = [];
  // the model in force for this document, chosen by the number printed on the file:
  // with two procedures registered, "the first one" would be a wrong answer
  const procedure = PROCEDURES.find((p) => filename.toUpperCase().includes(p.id.toUpperCase())) ?? PROCEDURES[0];
  const file: EvolusFile = {
    bytes: documentBytes,
    filename,
    contentType: isTextDocument(filename) ? 'text/markdown' : 'application/octet-stream',
  };
  const text = isTextDocument(filename) ? decode(documentBytes) : '';

  let path: IntakeResult['path'] = 'local';
  let extracted = '';

  const agentId = process.env.EVOLUS_AGENT_ID?.trim();
  const extractorId = process.env.EVOLUS_EXTRACTOR_ID?.trim();
  if (agentId && extractorId) {
    try {
      const asked = await askFileExtractor(agentId, 'json', extractorId, file, {
        procedure_id: procedure?.id ?? '',
        document: filename,
        ask: 'Return the document number, revision, effective date and every numbered instruction in order.',
      });
      extracted = asked.data;
      path = 'ask-file';
      stages.push({ block: 'extractors.ask-file', ok: true, detail: `${asked.data.length} chars of ${asked.contentType}`, executionId: asked.executionId, auditId: asked.auditId });
    } catch (e) {
      stages.push(stageFailed('extractors.ask-file', e));
    }
  } else {
    stages.push({ block: 'extractors.ask-file', ok: false, skipped: 'EVOLUS_AGENT_ID and EVOLUS_EXTRACTOR_ID are both required for a published extractor' });
  }

  if (!extracted && evolusConfigured()) {
    try {
      const run = isTextDocument(filename)
        ? await runAiTool('doc-structure', text, { options: { format: 'json' } })
        : await runAiToolMedia('doc-structure', file, { format: 'json' });
      extracted = run.output;
      path = 'doc-structure';
      stages.push(stageFromRun('ai-tools.doc-structure', run));
    } catch (e) {
      stages.push(stageFailed('ai-tools.doc-structure', e));
    }
  } else if (!extracted) {
    stages.push({ block: 'ai-tools.doc-structure', ok: false, skipped: 'no Evolus credential, so the document was compared locally' });
  }

  const fields = localDiff(text || extracted, procedure);
  let platformDiff: string | undefined;
  if (extracted && evolusConfigured()) {
    try {
      const run = await runAiTool('compare', JSON.stringify({ id: procedure?.id, revision: procedure?.revision, steps: procedure?.steps.map((s) => ({ id: s.id, title: s.title, text: s.text })) }), {
        secondaryText: extracted,
        options: { mode: 'field-level' },
      });
      platformDiff = run.output;
      stages.push(stageFromRun('ai-tools.compare', run));
    } catch (e) {
      stages.push(stageFailed('ai-tools.compare', e));
    }
  } else {
    stages.push({ block: 'ai-tools.compare', ok: false, skipped: 'extraction fell back to the local path, so there is nothing for the platform to compare against' });
  }

  const differing = fields.filter((f) => f.status !== 'match').length;
  return {
    filename,
    path,
    procedureId: procedure?.id ?? 'none',
    fields,
    summary: `${fields.length} fields checked, ${differing} not matching`,
    platformDiff,
    stages,
    note: path === 'local' ? 'compared in-process against the compiled model; no Evolus block ran' : `extracted by ${path}, diffed in-process`,
  };
}

/**
 * Field-level diff between a document and the model in force.
 *
 * Whitespace and Markdown emphasis are normalised because a document controller
 * edits formatting as well as content, and a revision that only changed bold text
 * is not a change to the procedure.
 */
export function localDiff(documentText: string, procedure = PROCEDURES[0]): DiffField[] {
  const norm = (s: string) => s.toLowerCase().replace(/[*_`#>-]/g, ' ').replace(/\s+/g, ' ').trim();
  const hay = norm(documentText);
  const fields: DiffField[] = [];

  // a document number is two letter groups and a digit group: an asset tag such as
  // TK-101 has the same shape as a number and would otherwise be read as one
  const docId = /\*\*Document:\*\*\s*([A-Z0-9-]+)/.exec(documentText)?.[1]
    ?? /\b([A-Z]{2,}-[A-Z]{2,}-\d+[A-Z0-9-]*)\b/.exec(documentText)?.[1]
    ?? '';
  const docRev = /\*\*Revision:\*\*\s*\**\s*([A-Za-z0-9.-]+)/i.exec(documentText)?.[1] ?? '';
  if (procedure) {
    fields.push({ field: 'document id', ours: procedure.id, document: docId, status: docId === procedure.id ? 'match' : docId ? 'differs' : 'only_ours' });
    fields.push({ field: 'revision', ours: procedure.revision, document: docRev, status: docRev === procedure.revision ? 'match' : docRev ? 'differs' : 'only_ours' });
    fields.push({ field: 'twin', ours: procedure.twin, document: '', status: 'only_ours' });

    for (const s of procedure.steps) {
      const inDoc = hay.includes(norm(s.text)) || (norm(s.title).length > 8 && hay.includes(norm(s.title)));
      fields.push({ field: `step ${s.id}`, ours: s.title, document: inDoc ? 'present' : 'absent', status: inDoc ? 'match' : 'only_ours' });
    }

    const printed = [...documentText.matchAll(/^\s*(\d{1,3})[.)]\s+(.+)$/gm)].map((m) => m[2]);
    const unmatched = printed.filter((line) => !procedure.steps.some((s) => norm(s.text).includes(norm(line)) || norm(line).includes(norm(s.text))));
    for (const line of unmatched) {
      fields.push({ field: 'printed instruction', ours: 'not modelled', document: line.slice(0, 90), status: 'only_document' });
    }
  }
  return fields;
}

/* ------------------------------------------------------- 2) change order routing */

export interface ChangeOrderRequest {
  markdown: string;
  facts?: ChangeOrderFacts;
  file?: EvolusFile;
  author?: 'model' | 'offline';
}

export interface ChangeOrderFlowResult {
  path: 'evolus' | 'partial' | 'local';
  status?: ExecutionStatus;
  executionId?: string;
  jobId?: string;
  traceId?: string;
  digest?: string;
  stages: FlowStage[];
  creditsConsumed: number;
  note: string;
}

/**
 * Route a change order for approval.
 *
 * Anonymise first, then digest, then hand the signed artefact to the customer's
 * workflow: the file that leaves this process must not carry an operator's name
 * into a general-purpose platform, and the workflow needs a summary short enough
 * that an approver reads it. A `Failed` execution is returned rather than thrown,
 * because the record of a rejected change order is the product, not an error.
 */
export async function routeChangeOrder(req: ChangeOrderRequest): Promise<ChangeOrderFlowResult> {
  const stages: FlowStage[] = [];
  const workflowId = process.env.EVOLUS_WORKFLOW_CHANGE_ORDER?.trim();
  let credits = 0;

  if (!evolusConfigured()) {
    stages.push({ block: 'ai-tools.anonymize', ok: false, skipped: 'no Evolus credential' });
    stages.push({ block: 'ai-tools.summarize', ok: false, skipped: 'no Evolus credential' });
    stages.push({ block: 'workflow.execute', ok: false, skipped: workflowId ? 'no Evolus credential' : 'EVOLUS_WORKFLOW_CHANGE_ORDER is not set' });
    return { path: 'local', stages, creditsConsumed: 0, note: 'change order kept in-process; nothing was routed' };
  }

  let anonymized = '';
  try {
    // a file when we have one: run-file keeps the document structure that a text
    // round trip would flatten, and it is the only route that bills per document
    if (req.file) {
      const out = await runAiToolFile('anonymize', req.file, { keep: 'device tags' });
      anonymized = decode(out.bytes);
      credits += out.creditsConsumed;
      stages.push({ block: 'ai-tools.run-file(anonymize)', ok: true, detail: out.filename, creditsConsumed: out.creditsConsumed });
    } else {
      const run = await runAiTool('anonymize', req.markdown, { options: { keep: 'device tags' } });
      anonymized = run.output;
      credits += run.creditsConsumed;
      stages.push(stageFromRun('ai-tools.anonymize', run));
    }
  } catch (e) {
    stages.push(stageFailed('ai-tools.anonymize', e));
    anonymized = req.markdown;
  }

  let digest = '';
  try {
    const run = await runAiTool('summarize', anonymized, { options: { audience: 'operations superintendent', maxSentences: 5 } });
    digest = run.output;
    credits += run.creditsConsumed;
    stages.push(stageFromRun('ai-tools.summarize', run));
  } catch (e) {
    stages.push(stageFailed('ai-tools.summarize', e));
    digest = anonymized.slice(0, 400);
  }

  if (!workflowId) {
    stages.push({ block: 'workflow.execute', ok: false, skipped: 'EVOLUS_WORKFLOW_CHANGE_ORDER is not set; the digest is returned unrouted' });
    return { path: 'partial', digest, stages, creditsConsumed: credits, note: 'anonymised and summarised, no approval workflow configured' };
  }

  try {
    const callback = process.env.EVOLUS_CALLBACK_BASE_URL?.trim();
    // the anonymised artefact is what travels: a personal name must not leave this
    // process in a file part simply because the approval workflow wants "the order"
    const attach = anonymized || req.markdown;
    const accepted = await executeWorkflow(workflowId, {
      input: digest,
      files: [{ bytes: new TextEncoder().encode(attach), filename: `${req.facts?.order ?? 'change-order'}.md`, contentType: 'text/markdown' }],
      parameters: {
        procedure: req.facts?.procedureId ?? PROCEDURES[0]?.id ?? 'unknown',
        from_revision: req.facts?.from ?? '',
        to_revision: req.facts?.to ?? '',
        failure_delta_pts: req.facts?.deltaPts ?? '',
        ci_pts: req.facts?.ciPts ?? '',
        risk_pct: req.facts?.riskPct ?? '',
        net_eur: req.facts?.netEur ?? '',
        drafted_by: req.author ?? 'offline',
      },
      ...(callback ? { callbackUrl: `${callback.replace(/\/$/, '')}/api/evolus/callback`, callbackMethod: 'POST' as const } : {}),
    });
    stages.push({ block: 'workflow.execute', ok: true, executionId: accepted.executionId, jobId: accepted.jobId, traceId: accepted.traceId, detail: `accepted ${accepted.httpStatus}` });

    const state = await pollExecution(workflowId, accepted.executionId);
    stages.push({ block: 'workflow.poll', ok: state.status === 'Completed', detail: `${state.status} after ${state.polls} poll(s)`, executionId: state.executionId });
    credits += Number(state.raw.creditsConsumed ?? 0);

    // if the anonymiser failed, the document that travelled is the one as written,
    // and the approver has to be told that rather than finding out later
    const leaked = stages.some((s) => s.block.startsWith('ai-tools.anonymize') && !s.ok && !s.skipped);

    return {
      path: state.status === 'Completed' ? 'evolus' : 'partial',
      status: state.status,
      executionId: accepted.executionId,
      jobId: accepted.jobId,
      traceId: accepted.traceId,
      digest,
      stages,
      creditsConsumed: credits,
      note: `${state.status === 'Completed' ? `workflow ${workflowId} completed execution ${accepted.executionId}` : `workflow ${workflowId} ended ${state.status} for execution ${accepted.executionId}`}${leaked ? '; anonymisation failed, the order was routed as written' : ''}`,
    };
  } catch (e) {
    const err = e as EvolusError;
    stages.push({ block: 'workflow.execute', ok: false, error: err.message, errorCode: err.errorCode, traceId: err.traceId });
    return { path: 'partial', digest, stages, creditsConsumed: credits, note: `routing failed: ${err.message}` };
  }
}

/* ------------------------------------------------------- 3) knowledge question */

export interface AskRequest {
  question: string;
  conversationId?: string;
}

export interface AskResult {
  path: 'agent-chat' | 'local';
  answer: string;
  conversationId?: string;
  model?: string;
  citations: { stepId: string; text: string; procedureId: string }[];
  stages: FlowStage[];
  note: string;
}

/**
 * Ask the incident and SOP library a question.
 *
 * History lives on the platform: the conversation id from the response is sent
 * back on the next turn, so this process keeps no transcript of what a person
 * asked. The system turn states the library the answer must come from, which is
 * the honest scope boundary we can express from here - the binding of the library
 * to the agent is configured on Evolus, and a question outside it is their agent's
 * refusal, not our filter.
 */
export async function askKnowledge(req: AskRequest): Promise<AskResult> {
  const agentId = process.env.EVOLUS_AGENT_ID?.trim();
  const citations = localCitations(req.question);
  if (!agentId || !evolusConfigured()) {
    return {
      path: 'local',
      answer: localAnswer(req.question, citations),
      citations,
      stages: [{ block: 'agent.chat', ok: false, skipped: agentId ? 'no Evolus credential' : 'EVOLUS_AGENT_ID is not set; answered from the compiled model in-process' }],
      note: 'no agent conversation was opened; the answer is retrieved from the procedure model in this process',
    };
  }

  const library = process.env.EVOLUS_MEMORY_LIBRARY_ID?.trim();
  try {
    const reply = await agentChat(req.question, {
      agentId,
      conversationId: req.conversationId,
      history: [
        {
          role: 'system',
          content: `Answer only from the incident and controlled-procedure knowledge library${library ? ` ${library}` : ''} and cite the document or step you used. If the library does not cover it, say so. Plant: ${PROCEDURES.map((p) => `${p.id} rev ${p.revision}`).join(', ')}.`,
        },
      ],
    });
    return {
      path: 'agent-chat',
      answer: reply.text,
      conversationId: reply.conversationId,
      model: reply.model,
      citations,
      stages: [{ block: 'agent.chat', ok: true, detail: `${reply.text.length} chars in ${reply.ms} ms`, conversationId: reply.conversationId }],
      note: reply.conversationId ? `continued conversation ${reply.conversationId}` : 'the platform returned no conversation id; the next turn will start fresh',
    };
  } catch (e) {
    const err = e as EvolusError;
    return {
      path: 'local',
      answer: localAnswer(req.question, citations),
      citations,
      stages: [{ block: 'agent.chat', ok: false, error: err.message }],
      note: 'the agent did not answer; the fallback is a keyword retrieval over the compiled model, not a platform answer',
    };
  }
}

/* ---------------------------------------------------- 3b) streaming variant */

export interface AskStreamResult {
  stream: ReadableStream<Uint8Array>;
  conversationId?: string;
  model?: string;
  path: 'agent-chat' | 'local';
  note: string;
}

function sseEvent(enc: TextEncoder, type: string, payload: unknown): Uint8Array {
  return enc.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Stream the answer as SSE.
 *
 * The upstream `X-Conversation-Id` is read before the body is handed on, because
 * once a response is a stream its headers are gone - and the id is the only way a
 * caller can continue the conversation the platform is holding.
 */
export async function askKnowledgeStream(req: AskRequest): Promise<AskStreamResult> {
  const agentId = process.env.EVOLUS_AGENT_ID?.trim();
  const enc = new TextEncoder();
  const citations = localCitations(req.question);
  const library = process.env.EVOLUS_MEMORY_LIBRARY_ID?.trim();

  const localStream = (answer: string, note: string) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sseEvent(enc, 'delta', { text: answer, citations }));
        controller.enqueue(sseEvent(enc, 'done', { path: 'local', note }));
        controller.close();
      },
    });
    return { stream, path: 'local' as const, note };
  };

  if (!agentId || !evolusConfigured()) {
    const note = agentId ? 'no Evolus credential; answered from the compiled model' : 'EVOLUS_AGENT_ID is not set; answered from the compiled model';
    return { ...localStream(localAnswer(req.question, citations), note), note };
  }

  const history = [
    {
      role: 'system' as const,
      content: `Answer only from the incident and controlled-procedure knowledge library${library ? ` ${library}` : ''} and cite the document or step you used. If the library does not cover it, say so.`,
    },
  ];

  try {
    const { res, conversationId, model } = await agentChatStream(req.question, { agentId, conversationId: req.conversationId, history });
    const body = res.body;
    if (!body) return { ...localStream(localAnswer(req.question, citations), 'the agent returned an empty stream'), conversationId, model, note: 'the agent returned an empty stream' };

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = body.getReader();
    } catch {
      return { ...localStream(localAnswer(req.question, citations), 'the agent stream could not be read'), conversationId, model, note: 'unreadable stream' };
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim();
              buffer = buffer.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') {
                controller.enqueue(sseEvent(enc, 'done', { path: 'agent-chat', conversationId, model }));
                controller.close();
                return;
              }
              try {
                const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
                const text = j.choices?.[0]?.delta?.content;
                if (text) controller.enqueue(sseEvent(enc, 'delta', { text }));
              } catch {
                // an unparseable upstream line is skipped, not fatal to the answer
              }
            }
          }
          controller.enqueue(sseEvent(enc, 'done', { path: 'agent-chat', conversationId, model }));
          controller.close();
        } catch (e) {
          controller.enqueue(sseEvent(enc, 'done', { path: 'local', note: (e as Error).message }));
          controller.close();
        }
      },
    });
    return { stream, conversationId, model, path: 'agent-chat', note: conversationId ? `streaming conversation ${conversationId}` : 'the platform returned no conversation id' };
  } catch (e) {
    const err = e as EvolusError;
    return { ...localStream(localAnswer(req.question, citations), `agent error: ${err.message}`), note: `agent error: ${err.message}` };
  }
}

/* ------------------------------------------------------------ shared local path */

/** Which printed steps bear on a question. Cheap, deterministic, and auditable. */
export function localCitations(question: string, limit = 4): { stepId: string; text: string; procedureId: string }[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 3)
    .slice(0, 12);
  const scored = PROCEDURES.flatMap((p) =>
    p.steps.map((s) => {
      const hay = `${s.title} ${s.text} ${(s.errors ?? []).map((e) => e.text).join(' ')}`.toLowerCase();
      const score = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
      return { stepId: s.id, text: s.text, procedureId: p.id, score };
    }),
  )
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ stepId, text, procedureId }) => ({ stepId, text, procedureId }));
}

function localAnswer(question: string, citations: AskResult['citations']): string {
  if (!citations.length) {
    return `Nothing in the compiled model speaks to "${question.slice(0, 120)}". Available procedures: ${PROCEDURES.map((p) => `${p.id} rev ${p.revision} (${p.steps.length} steps)`).join('; ')}. Controls in the catalogue: ${CONTROL_CATALOGUE.length}, including ${CONTROL_CATALOGUE.slice(0, 3).map((c) => c.id).join(', ')}.`;
  }
  return `Answered from the compiled model in this process, not from the platform library.\n${citations.map((c, i) => `${i + 1}. ${c.procedureId} step ${c.stepId}: ${c.text}`).join('\n')}`;
}
