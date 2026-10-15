import { NextResponse } from 'next/server';
import { runRepairLoop } from '../../lib/fuzz';
import type { ConsoleConfig } from '../../lib/registry';
import { gpuConfigured, gpuHealth } from '../../lib/gpu';

export const runtime = 'nodejs';

/**
 * The repair loop, streamed.
 *
 * Testing a dozen controls against a baseline takes longer than a judge will
 * wait for a spinner, so each candidate is emitted as its own event the moment
 * its paired test finishes. The client renders the rejections as they arrive,
 * which is the honest version of the story: most ideas do not work, and the
 * value of the tool is that it can say so with a confidence interval.
 */
export async function POST(req: Request) {
  const { cfg, n } = (await req.json()) as { cfg?: ConsoleConfig; n?: number };
  if (!cfg?.procedureId) {
    return NextResponse.json({ error: 'cfg is required' }, { status: 400 });
  }
  const shifts = Math.min(20000, Math.max(500, n ?? cfg.n ?? 3000));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
      send({ phase: 'start', message: `amd service: ${gpuConfigured() ? 'attached' : 'not attached, using the node engine'}`, n: shifts });
      try {
        const result = await runRepairLoop(cfg, shifts, (e) => send(e));
        send({ phase: 'done', result });
      } catch (e) {
        send({ phase: 'error', message: (e as Error).message });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-amd-service': gpuConfigured() ? 'attached' : 'none',
    },
  });
}

/** Cheap probe used by the evidence panel. */
export async function GET() {
  return NextResponse.json({ gpu: gpuConfigured() ? await gpuHealth() : { reachable: false, error: 'not configured' } });
}
