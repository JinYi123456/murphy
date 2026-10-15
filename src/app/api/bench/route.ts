import { NextResponse } from 'next/server';
import bench from '../../../../data/bench/cpu_vs_amd.json';

export const runtime = 'nodejs';

/**
 * The throughput evidence.
 *
 * GET serves what was actually captured on a real machine, including the
 * statement that no AMD device was present for that run - the panel is more
 * useful with an honest CPU-only row in it than with an empty box. POST asks a
 * live accelerator service to measure again, and refuses rather than inventing a
 * number when no service is configured.
 */

interface CapturedRow {
  batch: number;
  skipped?: boolean;
  device?: string;
  wallS?: number;
  scenariosPerSecond?: number;
  reason?: string;
}

export async function GET() {
  const runs = (bench as { runs?: { used: string; deviceLabel?: string; gpuVisible?: boolean; rows?: CapturedRow[] }[] }).runs ?? [];
  const rows = runs.flatMap((run) =>
    (run.rows ?? [])
      .filter((r) => !r.skipped)
      .map((r) => ({
        label: run.deviceLabel ?? run.used,
        device: run.used,
        n: r.batch,
        wallMs: Math.round((r.wallS ?? 0) * 1000),
        shiftsPerSecond: r.scenariosPerSecond ?? 0,
      })),
  );
  const skipped = runs.flatMap((run) => (run.rows ?? []).filter((r) => r.skipped).map((r) => `${r.batch}: ${r.reason ?? 'skipped'}`));
  return NextResponse.json({
    rows,
    capturedAt: (bench as { generatedAt?: string }).generatedAt ?? null,
    host: (bench as { host?: Record<string, string> }).host ?? null,
    gpuPresent: (bench as { gpuPresent?: boolean }).gpuPresent === true,
    gpuAbsentReason: (bench as { gpuAbsentReason?: string }).gpuAbsentReason ?? null,
    skipped,
    reproduce: 'python services/gpu/bench.py --batches 1000,10000,100000',
  });
}

export async function POST(req: Request) {
  const base = process.env.AMD_GPU_URL;
  if (!base) {
    return NextResponse.json(
      { error: 'no accelerator service is configured, so a fresh measurement cannot be taken; the captured benchmark is available with GET' },
      { status: 501 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const batches = Array.isArray((body as { batches?: unknown }).batches) ? (body as { batches: number[] }).batches : [1000, 10000, 100000];
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/bench`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batches, devices: ['cpu', 'cuda'] }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: `accelerator service answered ${res.status}` }, { status: 502 });
    return NextResponse.json(JSON.parse(text));
  } catch (e) {
    return NextResponse.json({ error: `accelerator service unreachable: ${(e as Error).message}` }, { status: 502 });
  }
}
