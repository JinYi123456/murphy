import { NextResponse } from 'next/server';
import { parseProcedure } from '../../../../lib/llm/agents';

export const runtime = 'nodejs';

/**
 * Compile a controlled document into the model the simulator runs.
 *
 * The document, not a summary of it, is what has to be sent: an error surface is
 * written against the wording, and a paraphrase loses the "if in doubt" that the
 * finding rests on. The answer carries `author` and `llm` because a compiled
 * procedure from a served model and one from the offline rule are different
 * artefacts, and a judge is entitled to know which is on screen.
 */
export async function POST(req: Request) {
  let markdown = '';
  const contentType = req.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const part = form.get('document') ?? form.get('file');
    if (part instanceof Blob) markdown = await part.text();
    else markdown = typeof part === 'string' ? part : '';
  } else {
    const body = (await req.json().catch(() => null)) as { markdown?: string } | null;
    markdown = body?.markdown ?? '';
  }

  if (!markdown.trim()) {
    return NextResponse.json({ error: 'markdown is required', llm: { used: false, reason: 'no document in the request' } }, { status: 400 });
  }
  if (markdown.length > 200_000) {
    return NextResponse.json({ error: 'document is too large to compile in one pass', llm: { used: false, reason: 'input refused before the model was called' } }, { status: 413 });
  }

  const { result, llm } = await parseProcedure(markdown);
  return NextResponse.json({
    ...result,
    llm,
    provenance: { author: result.author, documentBytes: markdown.length, droppedKeys: result.dropped.length },
  });
}
