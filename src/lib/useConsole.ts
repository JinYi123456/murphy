'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONFIG, buildRunConfig, variantLabel } from './registry';
import type { ConsoleConfig } from './registry';
import { batch, batchOnServer, replay, repairStream } from './engineClient';
import type { CandidateTrial } from './fuzz';
import type { ShiftDto, SummaryDto } from './dto';

export type ViewId = 'line' | 'pressure' | 'blackbox' | 'lab' | 'evidence';

export interface HealthInfo {
  backends: {
    amd: { reachable: boolean; device?: string; torch?: string; hip?: string; error?: string; latencyMs?: number };
    llm: { configured: boolean; model?: string; endpoint?: string; note?: string };
    evolus: { configured: boolean };
  };
  model: {
    procedures: { id: string; title: string; revision: string; twin: string; steps: number; integrity: boolean; warnings: number }[];
    twins: { id: string; label: string; unit: string; hazardKind: string; vars: string[]; discs: string[]; params: Record<string, number> }[];
    personas: { id: string; label: string; notes: string }[];
    plants: { id: string; label: string; twin?: string; notes: string }[];
    methods: string[];
    controls: { id: string; label: string; tier: string; annualCostEur: number }[];
  };
}

export interface RepairState {
  running: boolean;
  log: { phase: string; message: string }[];
  baseline?: SummaryDto;
  trials: CandidateTrial[];
  stacked?: { summary: SummaryDto; verdict: { netEur: number; accepted: boolean; reasons: string[]; failure: { delta: number; ciLow: number; ciHigh: number } }; controls: string[] } | null;
}

/**
 * The single piece of application state.
 *
 * Deliberately not a library: one screen, one store, and a rule that every
 * number on it came from a run that happened, not from a constant.
 */
export function useConsole() {
  const [cfg, setCfgState] = useState<ConsoleConfig>(DEFAULT_CONFIG);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [traced, setTraced] = useState<ShiftDto[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [where, setWhere] = useState<'worker' | 'amd' | 'node' | null>(null);
  const [device, setDevice] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [view, setView] = useState<ViewId>('line');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [activeShift, setActiveShift] = useState<ShiftDto | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [repair, setRepair] = useState<RepairState>({ running: false, log: [], trials: [] });
  const token = useRef(0);

  const run = buildRunConfig(cfg);
  const label = useMemo(() => variantLabel(cfg), [cfg]);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setHealth(j as HealthInfo))
      .catch(() => setHealth(null));
  }, []);

  const setCfg = useCallback((patch: Partial<ConsoleConfig>) => {
    setCfgState((prev) => ({ ...prev, ...patch }));
  }, []);

  const toggleControl = useCallback((id: string) => {
    setCfgState((prev) => ({
      ...prev,
      controls: prev.controls.includes(id) ? prev.controls.filter((c) => c !== id) : [...prev.controls, id],
    }));
  }, []);

  /**
   * Run the fuzz. `onAmd` sends it to the server, which forwards to the Instinct
   * service if one is attached; otherwise the local worker computes it. Either
   * way the chip in the header says which machine answered.
   */
  const runFuzz = useCallback(async (opts: { onAmd?: boolean } = {}) => {
    const my = ++token.current;
    setRunning(true);
    setError(null);
    setProgress({ done: 0, total: cfg.n });
    const t0 = performance.now();
    try {
      if (opts.onAmd) {
        const res = await batchOnServer(cfg, true);
        if (my !== token.current) return;
        setSummary(res.summary);
        setTraced(res.traced);
        setWhere(res.source === 'amd' ? 'amd' : 'node');
        setDevice('device' in res ? res.device : undefined);
        if (res.amdError) setError(`AMD service unavailable, node engine answered instead: ${res.amdError}`);
      } else {
        const res = await batch(buildRunConfig(cfg), cfg.n, variantLabel(cfg), {
          collectWorst: 14,
          onProgress: (done, total) => {
            if (my === token.current) setProgress({ done, total });
          },
        });
        if (my !== token.current) return;
        setSummary(res.summary);
        setTraced(res.traced);
        setWhere('worker');
        setDevice(undefined);
      }
      setElapsedMs(performance.now() - t0);
    } catch (e) {
      if (my === token.current) setError((e as Error).message);
    } finally {
      if (my === token.current) setRunning(false);
    }
  }, [cfg]);

  const loadReplay = useCallback(async (scn: number) => {
    const sh = await replay(buildRunConfig(cfg), scn);
    setActiveShift(sh);
    setView('blackbox');
    return sh;
  }, [cfg]);

  const runRepair = useCallback(async () => {
    setRepair({ running: true, log: [], trials: [] });
    try {
      const result = (await repairStream(cfg, Math.min(cfg.n, 6000), (e) => {
        setRepair((prev) => ({
          ...prev,
          log: [...prev.log, { phase: e.phase, message: e.message }],
          trials: e.trial ? [...prev.trials, e.trial as CandidateTrial] : prev.trials,
        }));
      })) as { baseline: SummaryDto; trials: CandidateTrial[]; stacked: RepairState['stacked'] } | null;
      if (result) setRepair({ running: false, log: [], trials: result.trials, baseline: result.baseline, stacked: result.stacked });
    } catch (e) {
      setRepair((prev) => ({ ...prev, running: false, log: [...prev.log, { phase: 'error', message: (e as Error).message }] }));
    }
  }, [cfg]);

  /** Re-run whenever the model under test changes, so the screen is never stale. */
  const dirty = summary?.variantId !== label;

  return {
    cfg, setCfg, toggleControl, run: runFuzz, runRepair, loadReplay,
    summary, traced, running, progress, where, device, error, elapsedMs,
    view, setView, selectedStep, setSelectedStep, activeShift, setActiveShift,
    health, repair, dirty, label, run_config: run,
  };
}

export type ConsoleStore = ReturnType<typeof useConsole>;
