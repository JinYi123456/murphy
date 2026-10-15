import { buildRunConfig } from '../../../lib/registry';
import type { ConsoleConfig } from '../../../lib/registry';
import { replayLocal } from '../../../lib/fuzz';

export const runtime = 'nodejs';

/**
 * Re-play one recorded shift.
 *
 * Nothing is stored: the scenario index and the seed are enough to reproduce the
 * trajectory, which is the same property a flight recorder relies on. Asking for
 * a shift twice, or inside a batch of a different size, returns the same tape.
 */
export async function POST(req: Request) {
  const { cfg, scn } = (await req.json()) as { cfg?: ConsoleConfig; scn?: number };
  if (!cfg || typeof scn !== 'number') {
    return Response.json({ error: 'cfg and scn are required' }, { status: 400 });
  }
  const shift = replayLocal(cfg, scn);
  const run = buildRunConfig(cfg);
  return Response.json({
    shift,
    twin: run.procedure.twin,
    variant: { revision: run.procedure.revision, controls: cfg.controls },
  });
}
