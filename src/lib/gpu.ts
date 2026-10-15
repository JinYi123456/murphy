/**
 * Client for the batched tensor engine, which is built to run on an AMD host.
 *
 * The service is optional by design: the product has to be demonstrable on a
 * laptop. But when it is present it is not decorative - it is doing the same
 * Monte-Carlo kernel with tensors instead of loops, and the UI reports which
 * machine answered, the device name and the throughput it measured.
 */
import type { RunEnvelope, SummaryDto } from './dto';
import type { ConsoleConfig } from './registry';
import { buildRunConfig, variantLabel } from './registry';
import type { RunConfig } from '../engine/types';

export function gpuUrl(): string | null {
  const url = process.env.AMD_GPU_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

export function gpuConfigured(): boolean {
  return gpuUrl() !== null;
}

export interface GpuHealth {
  reachable: boolean;
  device?: string;
  torch?: string;
  hip?: string;
  latencyMs?: number;
  error?: string;
}

export async function gpuHealth(timeoutMs = 2500): Promise<GpuHealth> {
  const base = gpuUrl();
  if (!base) return { reachable: false, error: 'AMD_GPU_URL is not set' };
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
    const j = (await res.json()) as Record<string, unknown>;
    return {
      reachable: true,
      device: String(j.device ?? j.name ?? 'AMD Instinct'),
      torch: j.torch ? String(j.torch) : undefined,
      hip: j.hip ? String(j.hip) : undefined,
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { reachable: false, error: (e as Error).message, latencyMs: Date.now() - t0 };
  }
}

/**
 * Ask the GPU for a batch. The compiled procedure travels with the request, so
 * a procedure variant that only exists in this session is still fuzzed on the
 * accelerator rather than silently downgraded to the local engine.
 */
export async function gpuRun(cfg: ConsoleConfig, run: RunConfig, timeoutMs = 60_000): Promise<RunEnvelope> {
  const base = gpuUrl();
  if (!base) throw new Error('no AMD service configured');
  const payload = {
    variant_id: variantLabel(cfg),
    procedure: run.procedure,
    persona: run.persona,
    plant: run.plant,
    method: run.method,
    seed: run.seed,
    n: cfg.n,
    collect_worst: 12,
  };
  const t0 = Date.now();
  const res = await fetch(`${base}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AMD service returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { summary?: SummaryDto; traced?: unknown[]; device?: string };
  if (!j.summary) throw new Error('AMD service returned no summary');
  return {
    summary: j.summary,
    traced: (j.traced ?? []) as RunEnvelope['traced'],
    source: 'amd',
    device: j.device,
    ms: Date.now() - t0,
  };
}

export async function gpuBench(batches: number[], timeoutMs = 180_000): Promise<unknown> {
  const base = gpuUrl();
  if (!base) throw new Error('no AMD service configured');
  const res = await fetch(`${base}/bench`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batches, devices: ['cpu', 'cuda'] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
