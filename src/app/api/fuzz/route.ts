import { NextResponse } from 'next/server';
import { buildRunConfig, variantLabel } from '../../../lib/registry';
import type { ConsoleConfig } from '../../../lib/registry';
import { runBatch } from '../../../engine/batch';
import { toShiftDto, toSummaryDto } from '../../../lib/dto';
import { gpuConfigured, gpuRun } from '../../../lib/gpu';

export const runtime = 'nodejs';

/**
 * Fuzz a procedure.
 *
 * If an AMD Instinct service is configured, the batch goes there and the answer
 * is labelled with the device that produced it. If it is not configured, or it
 * is unreachable, the Node engine answers and says so. There is no third path
 * in which the UI shows a GPU it does not have.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { cfg?: ConsoleConfig; trace?: boolean };
  const cfg = body.cfg;
  if (!cfg?.procedureId || !cfg.personaId || !cfg.plantId) {
    return NextResponse.json({ error: 'procedureId, personaId and plantId are required' }, { status: 400 });
  }
  const run = buildRunConfig(cfg);
  const collectWorst = body.trace ? 12 : 0;

  if (gpuConfigured()) {
    try {
      const remote = await gpuRun(cfg, run);
      return NextResponse.json(remote);
    } catch (e) {
      const { summary, traced } = runBatch(run, cfg.n, { variantId: variantLabel(cfg), collectWorst });
      return NextResponse.json({
        summary: toSummaryDto(summary),
        traced: traced.map(toShiftDto),
        source: 'node' as const,
        ms: 0,
        amdError: (e as Error).message,
      });
    }
  }

  const t0 = Date.now();
  const { summary, traced } = runBatch(run, cfg.n, { variantId: variantLabel(cfg), collectWorst });
  return NextResponse.json({
    summary: toSummaryDto(summary),
    traced: traced.map(toShiftDto),
    source: 'node' as const,
    ms: Date.now() - t0,
  });
}
