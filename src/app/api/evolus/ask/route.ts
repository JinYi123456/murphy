import { NextResponse } from 'next/server';
import { askKnowledge, askKnowledgeStream } from '../../../../lib/evolus/workflows';
import { evolusConfigured } from '../../../../lib/evolus/client';
import { ledgerSummary } from '../../../../lib/evolus/ledger';

export const runtime = 'nodejs';

/**
 * Ask the incident and SOP library.
 *
 * `?stream=1` gives SSE, because a knowledge answer over a slow link should arrive
 * as it is written. Either way the conversation id is handed back: history lives on
 * the platform, not in this process, and the id is the only thing that lets the
 * next question continue the one just asked. An unanswered question still returns a
 * retrieved answer from the compiled model and says that is what it is.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { question?: string; conversationId?: string } | null;
  const question = body?.question?.trim();
  const stream = new URL(req.url).searchParams.get('stream') === '1';

  if (!question) {
    if (stream) {
      const enc = new TextEncoder();
      return new Response(enc.encode('event: error\ndata: {"error":"question is required"}\n\n'), {
        status: 400,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    return NextResponse.json({ error: 'question is required', evolus: { configured: evolusConfigured() } }, { status: 400 });
  }

  const request = { question, conversationId: body?.conversationId };

  if (stream) {
    const result = await askKnowledgeStream(request);
    return new Response(result.stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        ...(result.conversationId ? { 'x-conversation-id': result.conversationId } : {}),
        'x-evolus-path': result.path,
      },
    });
  }

  const result = await askKnowledge(request);
  return NextResponse.json({ ...result, evolus: { configured: evolusConfigured(), path: result.path, ledger: ledgerSummary() } });
}
