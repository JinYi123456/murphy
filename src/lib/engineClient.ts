import type { WorkerReply, WorkerRequest } from './engine.worker';
import type { RunConfig } from '../engine/types';
import type { ConsoleConfig } from './registry';
import type { DiagnosisCase } from './diagnosis';
import type { SummaryDto, ShiftDto } from './dto';

/**
 * Promise wrapper around the simulation worker.
 *
 * A single shared worker is enough: the kernel is CPU-bound and running two
 * batches side by side would only make both slower and the throughput figure
 * meaningless.
 */

let worker: Worker | null = null;
let seq = 0;
type Waiter = {
  resolve: (r: WorkerReply) => void;
  onProgress?: (done: number, total: number) => void;
};
const waiting = new Map<number, Waiter>();

function getWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  if (worker) return worker;
  worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (ev: MessageEvent<WorkerReply>) => {
    const msg = ev.data;
    const w = waiting.get(msg.id);
    if (!w) return;
    if (msg.kind === 'progress') {
      w.onProgress?.(msg.done, msg.total);
      return;
    }
    waiting.delete(msg.id);
    w.resolve(msg);
  });
  return worker;
}

export interface BatchResult {
  summary: SummaryDto;
  traced: ShiftDto[];
  ms: number;
}

export async function inlineBatch(
  run: RunConfig,
  n: number,
  variantId: string,
  opts: { collectWorst?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BatchResult> {
  const { runBatch } = await import('../engine/batch');
  const { toSummaryDto, toShiftDto } = await import('./dto');
  const { summary, traced } = runBatch(run, n, {
    variantId,
    collectWorst: opts.collectWorst ?? 12,
    progressEvery: 20,
    onProgress: opts.onProgress,
  });
  return { summary: toSummaryDto(summary), traced: traced.map(toShiftDto), ms: 0 };
}

export function hasWorker(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

export function batch(
  run: RunConfig,
  n: number,
  variantId: string,
  opts: { collectWorst?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BatchResult> {
  const w = getWorker();
  if (!w) return inlineBatch(run, n, variantId, opts);
  const id = ++seq;
  return new Promise<BatchResult>((resolve, reject) => {
    waiting.set(id, {
      resolve: (r) => {
        if (r.kind === 'error') reject(new Error(r.message));
        else if (r.kind === 'batch') resolve({ summary: r.summary, traced: r.traced, ms: r.ms });
        else reject(new Error(`unexpected worker reply ${r.kind}`));
      },
      onProgress: opts.onProgress,
    });
    const req: WorkerRequest = { kind: 'batch', id, run, n, variantId, collectWorst: opts.collectWorst ?? 12 };
    w.postMessage(req);
  });
}

export function replay(run: RunConfig, scn: number): Promise<ShiftDto> {
  const w = getWorker();
  if (!w) {
    return import('../engine/runner').then(({ simulateShift }) =>
      import('./dto').then(({ toShiftDto }) => toShiftDto(simulateShift(run, scn, { trace: true, sampleEveryS: 8 }))),
    );
  }
  const id = ++seq;
  return new Promise<ShiftDto>((resolve, reject) => {
    waiting.set(id, {
      resolve: (r) => {
        if (r.kind === 'error') reject(new Error(r.message));
        else if (r.kind === 'replay') resolve(r.shift);
        else reject(new Error(`unexpected worker reply ${r.kind}`));
      },
    });
    w.postMessage({ kind: 'replay', id, run, scn } as WorkerRequest);
  });
}

/** Seed sensitivity: the same model, different random streams. */
export function sweep(run: RunConfig, n: number, seeds: string[]): Promise<{ seed: string; failureRate: number; meanCostEur: number }[]> {
  const w = getWorker();
  if (!w) return Promise.resolve([]);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, {
      resolve: (r) => {
        if (r.kind === 'error') reject(new Error(r.message));
        else if (r.kind === 'sweep') resolve(r.rows);
      },
    });
    w.postMessage({ kind: 'sweep', id, run, n, seeds } as WorkerRequest);
  });
}

/**
 * Rank the procedure's own error modes against one recorded instrument window.
 *
 * This is the heaviest thing the interface does - candidates x replicas shifts -
 * so it runs in the worker and keeps the screen alive. The server route is the
 * same function; nothing about the diagnosis depends on which machine answered.
 */
export function diagnoseCase(
  cfg: ConsoleConfig,
  scn: number,
  errorIndex: number,
  opts: { windowS?: number; replicas?: number } = {},
): Promise<DiagnosisCase> {
  const w = getWorker();
  if (!w) return import('./diagnosis').then((m) => m.analyseShift(cfg, scn, errorIndex, opts));
  const id = ++seq;
  return new Promise<DiagnosisCase>((resolve, reject) => {
    waiting.set(id, {
      resolve: (r) => {
        if (r.kind === 'error') reject(new Error(r.message));
        else if (r.kind === 'diagnose') resolve(r.case);
        else reject(new Error(`unexpected worker reply ${r.kind}`));
      },
    });
    w.postMessage({
      kind: 'diagnose', id, cfg, scn, errorIndex,
      windowS: opts.windowS ?? 2400, replicas: opts.replicas ?? 6,
    } as WorkerRequest);
  });
}

/** Ask the server, which will use the AMD Instinct service when it is attached. */
export async function batchOnServer(cfg: unknown, trace = true): Promise<{ summary: SummaryDto; traced: ShiftDto[]; source: string; device?: string; amdError?: string }> {
  const res = await fetch('/api/fuzz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cfg, trace }),
  });
  if (!res.ok) throw new Error(`fuzz failed: HTTP ${res.status}`);
  return res.json();
}

/** Stream the repair loop candidate by candidate. */
export async function repairStream(
  cfg: unknown,
  n: number,
  onEvent: (e: { phase: string; message: string; done?: number; total?: number; trial?: unknown }) => void,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch('/api/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cfg, n }),
    });
  } catch {
    res = null as unknown as Response;
  }
  if (!res || !res.ok || !res.body) {
    // No server: the loop is the same pure function, run here. The engine is
    // deliberately free of any Node-only import so the browser is a complete
    // implementation and not a demo shell around a backend.
    onEvent({ phase: 'start', message: `no server reachable - running the repair loop in this browser on ${n} shifts per candidate` });
    const { runRepairLoop } = await import('./fuzz');
    const result = await runRepairLoop(cfg as never, n, onEvent);
    onEvent({ phase: 'done', message: 'repair loop finished locally' });
    return result;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let final: unknown = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as { phase: string; message: string; result?: unknown };
      onEvent(evt);
      if (evt.phase === 'done') final = evt.result;
    }
  }
  return final;
}
