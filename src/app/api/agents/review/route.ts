import { NextResponse } from 'next/server';
import { reviewFindings, type Finding } from '../../../../lib/llm/agents';
import { available } from '../../../../lib/llm/client';

export const runtime = 'nodejs';

/**
 * Adversarial review of findings.
 *
 * The reviewer is given the HEP derivation rows rather than the prose, because a
 * narrative survives any reading of itself: the only thing an independent check can
 * actually disagree with is the arithmetic. The batch limit is a served-model limit -
 * one pass per finding on one GPU - so it lifts when the probe says there is no
 * model to wait for and the rule reviewer answers locally.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { findings?: Finding[] } | Finding[] | null;
  const findings = Array.isArray(body) ? body : (body?.findings ?? []);
  if (!findings.length) {
    return NextResponse.json({ error: 'findings[] is required', verdicts: [], llm: { used: false, reason: 'no findings in the request' } }, { status: 400 });
  }

  const limit = (await available()) ? 12 : 60;
  if (findings.length > limit) {
    return NextResponse.json({ error: `send at most ${limit} findings per call`, verdicts: [], llm: { used: false, reason: 'request refused' } }, { status: 413 });
  }

  const malformed = findings.find((f) => !f?.id || !f?.step || !f?.hep?.rows);
  if (malformed) {
    return NextResponse.json(
      { error: `finding ${malformed.id ?? '(unnamed)'} needs id, step and the hep derivation`, verdicts: [], llm: { used: false, reason: 'incomplete finding' } },
      { status: 400 },
    );
  }

  const { result, llm } = await reviewFindings(findings);
  return NextResponse.json({ ...result, llm });
}
