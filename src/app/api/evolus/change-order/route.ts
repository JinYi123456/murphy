import { NextResponse } from 'next/server';
import { routeChangeOrder } from '../../../../lib/evolus/workflows';
import { EVOLUS_MAX_CHARS, evolusConfigured } from '../../../../lib/evolus/client';
import { ledgerSummary } from '../../../../lib/evolus/ledger';
import type { ChangeOrderFacts } from '../../../../lib/llm/agents';

export const runtime = 'nodejs';

/**
 * Route a drafted change order for approval.
 *
 * The order is anonymised before it leaves this process, then digested, then handed
 * to the customer's workflow with the document attached - which is the sequence a
 * real MOC goes through, and the reason it is one call from the interface rather
 * than three from a browser. The execution id in the answer is the platform's, and
 * it is what makes the claim checkable.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    markdown?: string;
    facts?: import('../../../../lib/llm/agents').ChangeOrderFacts;
    author?: 'model' | 'offline';
  } | null;

  const markdown = body?.markdown?.trim();
  if (!markdown) {
    return NextResponse.json({ error: 'markdown is required', evolus: { configured: evolusConfigured() } }, { status: 400 });
  }
  if (markdown.length > EVOLUS_MAX_CHARS) {
    return NextResponse.json(
      { error: `the order is ${markdown.length} characters, over the platform's ${EVOLUS_MAX_CHARS} character ceiling`, evolus: { configured: evolusConfigured() } },
      { status: 413 },
    );
  }

  const result = await routeChangeOrder({ markdown, facts: body?.facts, author: body?.author });
  return NextResponse.json({ ...result, evolus: { configured: evolusConfigured(), ledger: ledgerSummary() } });
}
