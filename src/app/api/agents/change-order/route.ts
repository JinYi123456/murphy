import { NextResponse } from 'next/server';
import { draftChangeOrder, type RepairLoopResult } from '../../../../lib/llm/agents';
import { runRepairLoop } from '../../../../lib/fuzz';
import type { ConsoleConfig } from '../../../../lib/registry';
import { procedureById } from '../../../../lib/registry';

export const runtime = 'nodejs';

/**
 * Draft the change order for a repair run.
 *
 * Either the loop result comes back with the request, or the configuration does
 * and the loop is run here: the second path exists because a change order is only
 * worth drafting against the run that produced it, and making the browser hold
 * both is how the two drift apart.
 *
 * Every figure in the returned Markdown is interpolated from the run record by the
 * code, never typed by the model. The drafting agent writes the argument; the
 * numbers are evidence, and evidence does not come from a sampler.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | (RepairLoopResult & { cfg?: ConsoleConfig; n?: number; loop?: RepairLoopResult })
    | null;
  if (!body) {
    return NextResponse.json({ error: 'a repair loop result or a cfg is required', llm: { used: false, reason: 'no body' } }, { status: 400 });
  }

  let loop: RepairLoopResult;
  try {
    const supplied = body.loop ?? body;
    if (supplied.baseline && supplied.trials) {
      loop = supplied;
    } else if (body.cfg?.procedureId) {
      const cfg = body.cfg;
      const shifts = Math.min(20_000, Math.max(500, body.n ?? cfg.n ?? 3000));
      const run = await runRepairLoop({ ...cfg, n: shifts }, shifts);
      loop = {
        procedureId: cfg.procedureId,
        revision: procedureById(cfg.procedureId).revision,
        config: { persona: cfg.personaId, plant: cfg.plantId, method: cfg.method, seed: cfg.seed, shifts },
        ...run,
      };
    } else {
      return NextResponse.json({ error: 'either a repair loop result or cfg.procedureId is required', llm: { used: false, reason: 'incomplete request' } }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, llm: { used: false, reason: 'the loop could not be run' } }, { status: 400 });
  }

  const { result, llm } = await draftChangeOrder(loop);
  return NextResponse.json({ ...result, llm });
}
