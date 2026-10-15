/**
 * The simulation in a worker thread.
 *
 * A pressure test is tens of thousands of shifts and the interface still has to
 * animate, scrub and respond while it runs. Nothing here talks to the DOM; the
 * worker returns plain JSON-safe messages because typed arrays do not survive a
 * structured clone reliably across every runtime we target.
 */
import { runBatch } from '../engine/batch';
import { simulateShift } from '../engine/runner';
import { analyseShift } from './diagnosis';
import { toShiftDto, toSummaryDto } from './dto';
import type { ConsoleConfig } from './registry';
import type { DiagnosisCase } from './diagnosis';
import type { RunConfig } from '../engine/types';

export type WorkerRequest =
  | { kind: 'batch'; id: number; run: RunConfig; n: number; variantId: string; collectWorst: number }
  | { kind: 'replay'; id: number; run: RunConfig; scn: number }
  | { kind: 'diagnose'; id: number; cfg: ConsoleConfig; scn: number; errorIndex: number; windowS: number; replicas: number }
  | { kind: 'sweep'; id: number; run: RunConfig; n: number; seeds: string[] };

export type WorkerReply =
  | { kind: 'progress'; id: number; done: number; total: number }
  | { kind: 'batch'; id: number; summary: ReturnType<typeof toSummaryDto>; traced: ReturnType<typeof toShiftDto>[]; ms: number }
  | { kind: 'replay'; id: number; shift: ReturnType<typeof toShiftDto> }
  | { kind: 'diagnose'; id: number; case: DiagnosisCase }
  | { kind: 'sweep'; id: number; rows: { seed: string; failureRate: number; meanCostEur: number }[] }
  | { kind: 'error'; id: number; message: string };

interface WorkerScope {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void) => void;
}

const ctx = globalThis as unknown as WorkerScope;

function post(msg: WorkerReply, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

ctx.addEventListener('message', (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const t0 = Date.now();
  try {
    if (req.kind === 'batch') {
      const run = req.run as unknown as RunConfig;
      const { summary, traced } = runBatch(run, req.n, {
        variantId: req.variantId,
        collectWorst: req.collectWorst,
        progressEvery: 20,
        onProgress: (done, total) => post({ kind: 'progress', id: req.id, done, total }),
      });
      post({ kind: 'batch', id: req.id, summary: toSummaryDto(summary), traced: traced.map(toShiftDto), ms: Date.now() - t0 });
      return;
    }
    if (req.kind === 'replay') {
      const shift = simulateShift(req.run as unknown as RunConfig, req.scn, { trace: true, sampleEveryS: 8 });
      post({ kind: 'replay', id: req.id, shift: toShiftDto(shift) });
      return;
    }
    if (req.kind === 'diagnose') {
      post({
        kind: 'diagnose', id: req.id,
        case: analyseShift(req.cfg, req.scn, req.errorIndex, { windowS: req.windowS, replicas: req.replicas }),
      });
      return;
    }
    const rows = req.seeds.map((seed) => {
      const s = runBatch({ ...req.run, seed } as unknown as RunConfig, req.n).summary;
      return { seed, failureRate: s.failureRate, meanCostEur: s.meanCostEur };
    });
    post({ kind: 'sweep', id: req.id, rows });
  } catch (e) {
    post({ kind: 'error', id: req.id, message: (e as Error).message });
  }
});

export {};
