import { NextResponse } from 'next/server';
import { intakeProcedure } from '../../../../lib/evolus/workflows';
import { EVOLUS_MAX_BYTES, evolusConfigured } from '../../../../lib/evolus/client';
import { ledgerSummary } from '../../../../lib/evolus/ledger';

export const runtime = 'nodejs';

/**
 * Intake of a controlled document, passed through to the platform.
 *
 * Multipart in, multipart-shaped result out: the bytes that arrive from a browser
 * are the bytes the extractor sees, so nothing is re-encoded between the document
 * controller's folder and Evolus. The size ceiling is the vendor's own 20 MB,
 * enforced here because a refusal after a 30 second upload is worse than a refusal
 * at once.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? '';
  let bytes: Uint8Array | null = null;
  let filename = 'document';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const part = form.get('document') ?? form.get('file');
    if (part instanceof Blob) {
      if (part.size > EVOLUS_MAX_BYTES) {
        return NextResponse.json({ error: `document is ${part.size} bytes, over the platform's 20 MB ceiling`, evolus: { configured: evolusConfigured() } }, { status: 413 });
      }
      bytes = new Uint8Array(await part.arrayBuffer());
      filename = typeof (part as File).name === 'string' && (part as File).name ? (part as File).name : 'document';
    }
  } else {
    const body = (await req.json().catch(() => null)) as { text?: string; filename?: string } | null;
    if (typeof body?.text === 'string') {
      bytes = new TextEncoder().encode(body.text);
      filename = body.filename ?? 'document.md';
    }
  }

  if (!bytes || bytes.byteLength === 0) {
    return NextResponse.json({ error: 'a document part is required', evolus: { configured: evolusConfigured() } }, { status: 400 });
  }

  const result = await intakeProcedure(bytes, filename);
  return NextResponse.json({ ...result, evolus: { configured: evolusConfigured(), path: result.path, ledger: ledgerSummary() } });
}
