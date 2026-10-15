import { NextResponse } from 'next/server';
import { evolusStatus, EVOLUS_REST_ROOT, EVOLUS_CHAT_ROOT, AI_TOOLS } from '../../../../lib/evolus/client';
import { ledgerSummary, readLedger, recentExecutions } from '../../../../lib/evolus/ledger';

export const runtime = 'nodejs';

/**
 * What the Evolus integration can do right now.
 *
 * No platform call is made here: a status endpoint that spends credits or fails
 * because the vendor is having an afternoon is not a status endpoint. Presence of
 * each variable is reported by name, and the ledger carries the identifiers the
 * platform actually gave us, so a claim on screen can be checked against a real
 * execution id. The rows are timings, endpoints and identifiers - never payloads,
 * which is why they are safe to hand to a browser.
 */
export async function GET() {
  const status = evolusStatus();
  return NextResponse.json({
    configured: status.configured,
    env: status.env,
    missing: status.missing,
    note: status.note,
    blocksUsed: status.blocksUsed,
    ledger: ledgerSummary(),
    calls: readLedger(12),
    identifiers: recentExecutions(12),
    contract: {
      restRoot: EVOLUS_REST_ROOT,
      chatRoot: EVOLUS_CHAT_ROOT,
      aiTools: AI_TOOLS,
      rateLimitPerMinute: 60,
      maxChars: 120_000,
      maxDocumentBytes: 20 * 1024 * 1024,
      maxPdfPages: 60,
    },
    credentials: 'never returned; X-ApiKey / X-User-ApiKey are added server-side on each call',
  });
}
