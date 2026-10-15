import { NextResponse } from 'next/server';
import { analyseShift } from '../../../lib/diagnosis';
import type { ConsoleConfig } from '../../../lib/registry';

export const runtime = 'nodejs';

/**
 * Rank the procedure's own error modes against one instrument window.
 *
 * The browser worker runs the same function; this route exists so the figure can
 * be produced by a server too, and so the cost is visible rather than implied -
 * candidates multiplied by replicas is why a batched kernel on an Instinct card
 * matters here, and the response says how long it took.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    cfg?: ConsoleConfig; scn?: number; errorIndex?: number; windowS?: number; replicas?: number;
  };
  const cfg = body.cfg;
  if (!cfg?.procedureId || !cfg.personaId || !cfg.plantId || typeof body.scn !== 'number') {
    return NextResponse.json({ error: 'cfg (procedureId, personaId, plantId) and scn are required' }, { status: 400 });
  }
  if (cfg.controls && !Array.isArray(cfg.controls)) {
    return NextResponse.json({ error: 'controls must be an array of control ids' }, { status: 400 });
  }
  try {
    const result = analyseShift(cfg, body.scn, body.errorIndex ?? 0, {
      windowS: body.windowS, replicas: body.replicas,
    });
    return NextResponse.json({ ...result, source: 'node' });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
}
