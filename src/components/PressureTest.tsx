'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { batch, hasWorker, sweep } from '../lib/engineClient';
import { PERSONAS, buildRunConfig, variantLabel } from '../lib/registry';
import type { ConsoleConfig } from '../lib/registry';
import { HRA_METHODS } from '../engine/hra';
import type { HraMethod } from '../engine/hra';
import { costOf } from '../engine/economics';
import type { OutcomeClass } from '../engine/types';
import type { SummaryDto } from '../lib/dto';

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number, dp = 2) => `${(v * 100).toFixed(dp)}%`;

const METHOD_LABEL: Record<HraMethod, string> = { sparh: 'SPAR-H', therp: 'THERP', heart: 'HEART' };

/** Classes that mean something left containment or the equipment was damaged. */
const HAZARD_CLASSES = new Set<string>([
  'tank_breach', 'overfill', 'line_failure', 'containment_escape', 'minor_release',
  'deflagration', 'refractory_damage', 'shell_hotspot', 'hot_start',
]);
/** Classes that mean a hazard was released and held by secondary containment. */
const LOSS_CLASSES = new Set<string>([
  'misrouting', 'no_flow', 'short_batch', 'trip_stop', 'no_light_off', 'scrap_batch',
]);
/** Classes that mean nothing went wrong, or a later barrier caught it. */
const HELD_CLASSES = new Set<string>(['normal', 'intercepted']);

function kindOfOutcome(o: string): 'hazard' | 'loss' | 'held' {
  if (HAZARD_CLASSES.has(o)) return 'hazard';
  if (HELD_CLASSES.has(o)) return 'held';
  if (LOSS_CLASSES.has(o)) return 'loss';
  // an outcome name this screen does not know is drawn as a production loss,
  // never as a hazard it may not be
  return 'loss';
}

const COLOUR: Record<'hazard' | 'loss' | 'held', string> = {
  hazard: '#ff4a2f',
  loss: '#ffb03a',
  held: '#3ee08f',
};

interface AutoState {
  byMethod: Partial<Record<HraMethod, SummaryDto>>;
  seeds: { seed: string; failureRate: number; meanCostEur: number }[];
  phase: string;
  running: boolean;
  done: number;
  total: number;
  error: string | null;
  nMethod: number;
  nSeed: number;
}

const EMPTY_AUTO: AutoState = {
  byMethod: {}, seeds: [], phase: 'not started', running: false,
  done: 0, total: 0, error: null, nMethod: 0, nSeed: 0,
};

interface CrewRow {
  personaId: string;
  label: string;
  failureRate: number;
  failed: number;
  n: number;
  annualLossEur: number;
}

/**
 * Pressure test: the argument that this is a simulation and not a guess.
 *
 * Every block here answers the same suspicion. Which machine actually produced
 * the numbers - said out loud, including when it was a laptop. What the whole
 * outcome spectrum looks like, not only the failures. How heavy the money tail
 * is, with the interval drawn as what it is. And whether the finding survives a
 * change of reliability method, a change of random seed and a change of crew:
 * three methods and six seeds are run for real through the same kernel the
 * header reports, at a capped batch size, and the numbers that come back are
 * the numbers drawn.
 */
export function PressureTest({ s }: { s: ConsoleStore }) {
  const summary = s.summary;

  const [auto, setAuto] = useState<AutoState>(EMPTY_AUTO);
  const [nonce, setNonce] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  const [crew, setCrew] = useState<CrewRow[]>([]);
  const [crewBusy, setCrewBusy] = useState(false);
  const [crewProg, setCrewProg] = useState({ done: 0, total: 0 });
  const [crewError, setCrewError] = useState<string | null>(null);

  const queue = useRef<Promise<void>>(Promise.resolve());
  const token = useRef(0);
  const claimed = useRef<string | null>(null);
  const crewToken = useRef(0);

  /**
   * One serial queue for every extra batch this screen asks for. The kernel is
   * CPU-bound, a single worker services it, and twelve batches in flight would
   * only make each other slower and the throughput figure meaningless.
   */
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const started = queue.current.then(() => job());
    queue.current = started.then(() => undefined, () => undefined);
    return started;
  }, []);

  const nMethod = Math.min(4000, s.cfg.n);
  const nSeed = Math.min(3000, s.cfg.n);
  const nCrew = Math.min(2500, s.cfg.n);
  const seeds = useMemo(
    () => [s.cfg.seed, ...['a', 'b', 'c', 'd', 'e'].map((k) => `${s.cfg.seed}-${k}`)],
    [s.cfg.seed],
  );

  /**
   * Everything the two automatic passes depend on. The selected method is
   * deliberately absent: that pass tests all three methods, so changing the
   * method in the header must not buy another twelve thousand shifts.
   */
  const sig = useMemo(() => JSON.stringify([
    s.cfg.procedureId, s.cfg.plantId, s.cfg.personaId, s.cfg.seed,
    [...s.cfg.controls].sort(), nMethod, nSeed, nonce,
  ]), [s.cfg.procedureId, s.cfg.plantId, s.cfg.personaId, s.cfg.seed, s.cfg.controls, nMethod, nSeed, nonce]);

  useEffect(() => {
    if (!summary) return;
    // never compete with a batch the analyst just asked for; the effect re-runs
    // when running drops and claims the signature then
    if (s.running) return;
    if (claimed.current === sig) return;
    claimed.current = sig;
    const my = ++token.current;
    const live = () => token.current === my;
    const cfg = s.cfg;

    setAuto({
      byMethod: {}, seeds: [], phase: 'method sensitivity', running: true,
      done: 0, total: HRA_METHODS.length + 1, error: null, nMethod, nSeed,
    });

    void (async () => {
      for (let i = 0; i < HRA_METHODS.length; i++) {
        const m = HRA_METHODS[i];
        const next: ConsoleConfig = { ...cfg, method: m };
        try {
          const res = await enqueue(() =>
            batch(buildRunConfig(next), nMethod, variantLabel(next), { collectWorst: 0 }));
          if (!live()) return;
          setAuto((p) => ({ ...p, byMethod: { ...p.byMethod, [m]: res.summary }, done: i + 1 }));
        } catch (e) {
          if (live()) setAuto((p) => ({ ...p, running: false, error: (e as Error).message }));
          return;
        }
      }

      if (!hasWorker()) {
        if (live()) setAuto((p) => ({ ...p, running: false, phase: 'seed sweep unavailable: no worker in this runtime' }));
        return;
      }
      if (live()) setAuto((p) => ({ ...p, phase: 'seed sweep' }));
      try {
        const rows = await enqueue(() => sweep(buildRunConfig(cfg), nSeed, seeds));
        if (!live()) return;
        setAuto((p) => ({
          ...p, seeds: rows, running: false, done: p.total,
          phase: rows.length ? 'complete' : 'sweep returned no rows',
        }));
      } catch (e) {
        if (live()) setAuto((p) => ({ ...p, running: false, error: (e as Error).message }));
      }
    })();
  }, [sig, summary, s.running, s.cfg, enqueue, seeds, nMethod, nSeed]);

  /** Lazy on purpose: six full batches on every keystroke of the config would be a waste of real CPU seconds. */
  const runCrew = useCallback(() => {
    const my = ++crewToken.current;
    const cfg = s.cfg;
    setCrewBusy(true);
    setCrewError(null);
    setCrew([]);
    setCrewProg({ done: 0, total: PERSONAS.length });
    void (async () => {
      for (let i = 0; i < PERSONAS.length; i++) {
        const p = PERSONAS[i];
        const next: ConsoleConfig = { ...cfg, personaId: p.id };
        try {
          const res = await enqueue(() =>
            batch(buildRunConfig(next), nCrew, variantLabel(next), { collectWorst: 0 }));
          if (crewToken.current !== my) return;
          setCrew((prev) => [...prev, {
            personaId: p.id, label: p.label, failureRate: res.summary.failureRate,
            failed: res.summary.failed, n: res.summary.n, annualLossEur: res.summary.annualLossEur,
          }]);
          setCrewProg({ done: i + 1, total: PERSONAS.length });
        } catch (e) {
          if (crewToken.current === my) setCrewError((e as Error).message);
          break;
        }
      }
      if (crewToken.current === my) setCrewBusy(false);
    })();
  }, [s.cfg, enqueue, nCrew]);

  // every hook above and below this line stays unconditional: the recorded tail
  // is derived from the traced shifts, which exist whether or not a summary does
  const recorded = useMemo(() => {
    const twin = s.run_config.procedure.twin;
    const product = s.run_config.plant.product ?? 'default';
    return s.traced.map((sh) => ({
      scn: sh.scn,
      outcome: sh.outcome,
      // ShiftDto widens outcome to string for the wire; the engine only ever emits an OutcomeClass
      costEur: costOf(twin, sh.outcome as OutcomeClass, sh.peak, product).totalEur,
    })).sort((a, b) => b.costEur - a.costEur);
  }, [s.traced, s.run_config]);

  if (!summary) {
    return (
      <div className="panel p-4 text-[12px] text-ash">
        No batch has been run. The pressure test needs a completed fuzz to describe.
      </div>
    );
  }

  const spectrum = Object.entries(summary.outcomeCounts).sort((a, b) => b[1] - a[1]);
  const hovered = hover ? summary.outcomeCounts[hover] ?? 0 : null;

  const engine = engineLine(s.where, s.device, s.health?.backends.amd.reachable ?? false);

  const methods = HRA_METHODS.map((m) => ({ method: m, sum: auto.byMethod[m] ?? null }));
  const ready = methods.filter((x): x is { method: HraMethod; sum: SummaryDto } => x.sum !== null);
  const rankByMethod = ready.map(({ method, sum }) => ({
    method,
    top: Object.entries(sum.perStep)
      .filter(([, st]) => st.causalFailure > 0)
      .sort((a, b) => b[1].causalFailure - a[1].causalFailure)
      .slice(0, 3)
      .map(([id]) => id),
    rate: sum.failureRate,
  }));
  const complete = rankByMethod.length === HRA_METHODS.length;
  const sharedTop = complete ? rankByMethod[0].top.filter((id) => rankByMethod.every((r) => r.top.includes(id))) : [];
  const worst = rankByMethod.map((r) => r.top[0] ?? 'none');
  const hasRanking = complete && rankByMethod.every((r) => r.top.length > 0);
  const sameWorst = hasRanking && worst.every((w) => w === worst[0]);
  const levels = rankByMethod.map((r) => r.rate);
  const levelSpread = levels.length ? Math.max(...levels) - Math.min(...levels) : 0;
  const levelRatio = levels.length && Math.min(...levels) > 0 ? Math.max(...levels) / Math.min(...levels) : 0;
  const barMax = Math.max(1e-6, ...ready.map((r) => r.sum.failureRate));

  const seedRows = auto.seeds;
  const seedRates = seedRows.map((r) => r.failureRate);
  const seedLo = seedRates.length ? Math.min(...seedRates) : 0;
  const seedHi = seedRates.length ? Math.max(...seedRates) : 0;
  const seedMean = seedRates.length ? seedRates.reduce((a, b) => a + b, 0) / seedRates.length : 0;
  const seedSd = seedRates.length
    ? Math.sqrt(seedRates.reduce((a, b) => a + (b - seedMean) ** 2, 0) / seedRates.length)
    : 0;

  const crewSorted = [...crew].sort((a, b) => b.failureRate - a.failureRate);
  const crewMax = crewSorted.length ? Math.max(...crewSorted.map((c) => c.failureRate)) : 0;
  const crewMin = crewSorted.length ? Math.min(...crewSorted.map((c) => c.failureRate)) : 0;

  return (
    <div className="grid gap-4">
      {/* ----------------------------------------------------------- header */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Pressure test</h2>
          <p className="text-[12px] text-ash">
            {s.run_config.procedure.id} rev {s.run_config.procedure.revision} - {s.run_config.persona.label} -{' '}
            {s.run_config.plant.label} - seed {summary.seed}
          </p>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Big label="shifts run" value={summary.n.toLocaleString('en-US')} unit="shifts" />
          <Big label="wall time" value={(s.elapsedMs / 1000).toFixed(2)} unit="seconds, measured here"
            sub={`the engine itself reported ${(summary.wallMs / 1000).toFixed(2)} s`} />
          <Big label="throughput" value={summary.shiftsPerSecond.toLocaleString('en-US', { maximumFractionDigits: 0 })} unit="shifts / second" />
          <Big label="failure rate" value={pct(summary.failureRate)} unit={`${summary.failed} of ${summary.n.toLocaleString('en-US')}`}
            tone={summary.failureRate > 0.02 ? 'bad' : 'good'} />
        </div>

        <div className={`mt-4 border px-3 py-2.5 ${engine.tone}`}>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="label">which engine answered</span>
            <span className="readout text-[15px]">{engine.headline}</span>
            {s.device && <span className="readout text-[12px] text-ash">{s.device}</span>}
          </div>
          <p className="mt-1 max-w-[1000px] text-[11px] leading-relaxed text-ash">{engine.note}</p>
        </div>

        {s.dirty && (
          <p className="mt-3 border border-amber/40 bg-amber/8 px-3 py-2 text-[11px] text-amber">
            The configuration on the header bar ({s.label}) is not the configuration that produced these
            numbers. Every figure on this page still describes the run that happened.
          </p>
        )}
      </section>

      {/* -------------------------------------------------- outcome spectrum */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Outcome spectrum</h3>
          <p className="text-[11px] text-ash">every shift lands in exactly one class; the bar is the whole batch</p>
          {hover && hovered !== null && (
            <p className="ml-auto readout text-[12px] text-bone">
              <span className="text-amber">{hover}</span> - {hovered.toLocaleString('en-US')} shifts -{' '}
              {pct(hovered / summary.n)} of the batch - {labelFor(kindOfOutcome(hover))}
            </p>
          )}
        </div>

        <div className="mt-3 flex h-[26px] w-full overflow-hidden border border-rule bg-void">
          {spectrum.map(([cls, count]) => (
            <div key={cls}
              onMouseEnter={() => setHover(cls)} onMouseLeave={() => setHover(null)}
              title={`${cls}: ${count} shifts, ${pct(count / summary.n)}`}
              className="h-full border-r border-void/60"
              style={{
                width: `${(count / Math.max(1, summary.n)) * 100}%`,
                background: COLOUR[kindOfOutcome(cls)],
                opacity: hover && hover !== cls ? 0.3 : 0.85,
              }} />
          ))}
        </div>
        <div className="mt-1 rule-dot" />

        <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          {spectrum.map(([cls, count]) => (
            <li key={`lg-${cls}`}
              onMouseEnter={() => setHover(cls)} onMouseLeave={() => setHover(null)}
              className="flex items-baseline gap-2 text-[11px]">
              <span className="inline-block h-2 w-2 shrink-0" style={{ background: COLOUR[kindOfOutcome(cls)] }} />
              <span className="w-[136px] shrink-0 uppercase tracking-[0.1em] text-ash">{cls}</span>
              <span className="readout text-bone">{count.toLocaleString('en-US')}</span>
              <span className="readout text-ash">{pct(count / summary.n)}</span>
            </li>
          ))}
        </ul>

        <p className="mt-3 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          near-miss rate {pct(summary.nearMissRate)} - deviations that survived a step without reaching an
          outcome class. Mean hazard time per shift {summary.meanHazardS.toFixed(1)} s, mean elapsed{' '}
          {summary.meanElapsedS.toFixed(0)} s, mean quantity released {summary.meanReleaseM3.toFixed(3)} m3.
        </p>
      </section>

      {/* ------------------------------------------------ distribution of loss */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Distribution of loss</h3>
        <p className="mt-1 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          Per-shift consequence cost, recomputed from the {recorded.length} shifts the batch returned for
          replay. Those are the most expensive shifts in the batch by construction - a shift that cost nothing
          is not kept for replay - so this is the tail, not a sample of the batch. The aggregate figures below
          are computed over all {summary.n.toLocaleString('en-US')} shifts.
        </p>

        <Histogram recorded={recorded} />

        <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-4">
          <Readout label="mean per shift" value={eur(summary.meanCostEur)} />
          <CiWhisker ci={summary.costCi} />
          <Readout label="95th percentile" value={eur(summary.p95CostEur)} tone="warn" />
          <Readout label="CVaR 95%" value={eur(summary.cvarCostEur)} tone="bad" />
          <Readout label="annual exposure" value={eur(summary.annualLossEur)}
            sub={`${summary.shiftsPerYear.toLocaleString('en-US')} shifts a year`} />
          <Readout label="with escalation" value={eur(summary.annualEscalatedEur)} tone="bad" />
        </div>

        <p className="mt-4 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          CVaR is the average cost of the shifts at or beyond the 95th percentile. It is the number a budget
          decision turns on, because a reserve sized to the mean is empty on the day the bad one happens. The
          cyan whisker is the 95% confidence interval of the <span className="text-bone">mean</span> across the
          batch. It is not a range of what one shift can cost - that range is the histogram above, and it is
          much wider.
        </p>
      </section>

      {/* -------------------------------------------------- method sensitivity */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Method sensitivity</h3>
          <p className="text-[11px] text-ash">
            SPAR-H, THERP and HEART over the same model, {nMethod.toLocaleString('en-US')} shifts each
          </p>
          <span className="ml-auto text-[10px] uppercase tracking-[0.14em]">
            {auto.running
              ? <span className="text-amber">{auto.phase} {auto.done}/{auto.total}</span>
              : auto.error
                ? <span className="text-vermillion">recompute failed</span>
                : complete
                  ? <span className="text-phosphor">computed</span>
                  : <span className="text-ash">{auto.phase}</span>}
          </span>
        </div>

        {auto.error && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="text-[11px] text-vermillion">{auto.error}</p>
            <button onClick={() => setNonce((x) => x + 1)}
              className="border border-vermillion/50 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-vermillion hover:bg-vermillion/10">
              retry
            </button>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {methods.map(({ method, sum }) => (
            <div key={method} className="flex items-center gap-3">
              <span className={`w-[74px] shrink-0 text-[11px] uppercase tracking-[0.14em] ${s.cfg.method === method ? 'text-amber' : 'text-ash'}`}>
                {METHOD_LABEL[method]}
              </span>
              <div className="relative h-[18px] flex-1 bg-void">
                {sum ? (
                  <div className="absolute inset-y-0 left-0"
                    style={{
                      width: `${Math.min(100, (sum.failureRate / barMax) * 100)}%`,
                      background: s.cfg.method === method ? '#ffb03a' : '#4fd8ff',
                      opacity: 0.78,
                    }} />
                ) : (
                  <div className="absolute inset-0 rule-dot" />
                )}
                {sum && (
                  <span className="readout absolute inset-y-0 right-2 flex items-center text-[11px] text-bone">
                    {pct(sum.failureRate)} - {sum.failed}/{sum.n.toLocaleString('en-US')}
                  </span>
                )}
              </div>
              <span className="w-[132px] shrink-0 readout text-right text-[11px] text-ash">
                {sum ? `${eur(sum.annualLossEur)}/yr` : 'queued'}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left uppercase tracking-[0.12em] text-ash">
                <th className="pr-4 font-normal">method</th>
                <th className="pr-4 font-normal">worst steps by causal failures</th>
                <th className="pr-4 text-right font-normal">failure rate</th>
              </tr>
            </thead>
            <tbody>
              {rankByMethod.map((r) => (
                <tr key={`rk-${r.method}`} className="border-t border-rule">
                  <td className="py-1 pr-4 uppercase tracking-[0.12em] text-bone">{METHOD_LABEL[r.method]}</td>
                  <td className="py-1 pr-4 readout text-ash">{r.top.length ? r.top.join(', ') : 'no causal failures in this batch'}</td>
                  <td className="py-1 pr-4 text-right readout text-bone">{pct(r.rate)}</td>
                </tr>
              ))}
              {!rankByMethod.length && (
                <tr><td colSpan={3} className="py-2 text-ash">waiting for the first method to finish</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-3 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          {complete ? (
            <>
              <span className="text-bone">The point:</span> the absolute level moves with the method -{' '}
              {pct(Math.min(...levels))} to {pct(Math.max(...levels))}, {(levelSpread * 100).toFixed(2)} points
              {levelRatio ? `, ${levelRatio.toFixed(1)} times` : ''}
              {hasRanking ? (
                <>
                  {' '} - but{' '}
                  {sameWorst ? (
                    <>the worst step is <span className="text-vermillion">{worst[0]}</span> under all three methods and{' '}
                      {sharedTop.length} of its top three steps are common to all three. A ranking that survives a
                      change of method is a finding; the level underneath it is still only order-of-magnitude.</>
                  ) : (
                    <>the worst step is <span className="text-vermillion">{worst.join(' / ')}</span> depending on the
                      method, with only {sharedTop.length} of the top three in common. On this procedure the ranking
                      is method-dependent and should be reconciled against site data before anyone acts on it.</>
                  )}
                </>
              ) : (
                <>
                  {' '} - but this batch attributed no causal failure to any step under{' '}
                  {rankByMethod.map((r) => METHOD_LABEL[r.method]).join(', ')}
                  , so there is no ranking to compare yet. Raise the batch size or pick a harsher crew or plant
                  state; no ranking is claimed here on empty evidence.
                </>
              )}
            </>
          ) : (
            <>Computing. Three methods run in one pass through the same kernel; the sentence above writes itself from whatever comes back.</>
          )}
        </p>
      </section>

      {/* --------------------------------------------------- seed sensitivity */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Seed sensitivity</h3>
          <p className="text-[11px] text-ash">same model, six random streams, {nSeed.toLocaleString('en-US')} shifts each</p>
          {!seedRows.length && (
            <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-ash">{auto.running ? auto.phase : 'not run'}</span>
          )}
        </div>

        {seedRows.length ? (
          <>
            <div className="mt-4 space-y-1.5">
              {seedRows.map((r) => (
                <div key={r.seed} className="flex items-center gap-3">
                  <span className={`w-[220px] shrink-0 truncate text-[11px] ${r.seed === s.cfg.seed ? 'text-amber' : 'text-ash'}`}>
                    {r.seed}{r.seed === s.cfg.seed ? ' - header seed' : ''}
                  </span>
                  <div className="relative h-[14px] flex-1 bg-void">
                    <div className="absolute inset-y-0 left-0 bg-cyan"
                      style={{ width: `${Math.min(100, (r.failureRate / Math.max(1e-6, seedHi)) * 100)}%`, opacity: 0.7 }} />
                    <div className="absolute inset-y-[-3px] w-[1px] bg-bone"
                      style={{ left: `${Math.min(100, (seedMean / Math.max(1e-6, seedHi)) * 100)}%` }}
                      title={`mean of the six seeds: ${pct(seedMean)}`} />
                  </div>
                  <span className="readout w-[210px] shrink-0 text-right text-[11px] text-bone">
                    {pct(r.failureRate)} - {eur(r.meanCostEur)}/shift
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
              <Readout label="lowest seed" value={pct(seedLo)} />
              <Readout label="highest seed" value={pct(seedHi)} />
              <Readout label="spread" value={`${(levelSpan(seedLo, seedHi))} pts`} tone={seedHi - seedLo > 0.005 ? 'warn' : 'good'} />
              <Readout label="standard deviation" value={`${(seedSd * 100).toFixed(3)} pts`} />
            </div>
            <p className="mt-3 max-w-[1000px] text-[11px] leading-relaxed text-ash">
              A claim that only appears at one seed is not a claim. The pale rule is the six-seed mean and the
              header seed sits inside the spread, which is why every before/after comparison in the change lab
              is paired scenario by scenario rather than run against run.
            </p>
          </>
        ) : (
          <p className="mt-4 text-[11px] text-ash">
            {auto.running ? 'Queued behind the method pass.' : 'No rows. The sweep runs in the simulation worker, and this runtime has none, so there is nothing to show rather than something to assume.'}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------- crew comparison */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Same procedure, six crews</h3>
          <p className="text-[11px] text-ash">
            procedure, plant state, controls, method and seed held fixed; only the crew changes.{' '}
            {nCrew.toLocaleString('en-US')} shifts each.
          </p>
          <button onClick={runCrew}
            disabled={s.running || crewBusy}
            className={`ml-auto border px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] ${
              crew.length ? 'border-rule text-ash hover:border-amber hover:text-amber' : 'border-amber bg-amber/12 text-amber'
            } disabled:opacity-40`}>
            {crewBusy ? `computing ${crewProg.done}/${crewProg.total}` : crew.length ? 'recompute' : 'compute six crews'}
          </button>
        </div>

        {crewError && <p className="mt-2 text-[11px] text-vermillion">{crewError}</p>}
        {s.running && !crewBusy && (
          <p className="mt-2 text-[11px] text-amber">a batch is already running on this machine; the queue waits for it.</p>
        )}

        {crewSorted.length ? (
          <>
            <div className="mt-4 space-y-1.5">
              {crewSorted.map((c) => (
                <div key={c.personaId} className="flex items-center gap-3">
                  <span className={`w-[300px] shrink-0 truncate text-[11px] ${c.personaId === s.cfg.personaId ? 'text-amber' : 'text-ash'}`}>
                    {c.label}
                  </span>
                  <div className="relative h-[18px] flex-1 bg-void">
                    <div className="absolute inset-y-0 left-0"
                      style={{
                        width: `${Math.min(100, (c.failureRate / Math.max(1e-6, crewMax)) * 100)}%`,
                        background: c.failureRate > 0.05 ? '#ff4a2f' : c.failureRate > 0.01 ? '#ffb03a' : '#3ee08f',
                        opacity: 0.82,
                      }} />
                    <div className="absolute inset-0 rule-dot" />
                    <span className="readout absolute inset-y-0 right-2 flex items-center text-[11px] text-bone">
                      {pct(c.failureRate)}
                    </span>
                  </div>
                  <span className="w-[196px] shrink-0 readout text-right text-[11px] text-ash">
                    {c.failed}/{c.n.toLocaleString('en-US')} - {eur(c.annualLossEur)}/yr
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 max-w-[1000px] text-[11px] leading-relaxed text-ash">
              {crewSorted.length} crews, {nCrew.toLocaleString('en-US')} shifts each: the spread is{' '}
              {((crewMax - crewMin) * 100).toFixed(2)} points
              {crewMin > 0 ? `, ${(crewMax / crewMin).toFixed(1)} times from the careful crew to the worst` : ''}.
              Same words, same paper, same plant, same seed - different people. That is the whole reason a
              procedure cannot be judged by how it reads.
            </p>
          </>
        ) : (
          <p className="mt-4 text-[11px] text-ash">
            Not computed. Six full batches cost real CPU seconds, so this one waits for the button.
          </p>
        )}
      </section>
    </div>
  );
}

function levelSpan(lo: number, hi: number): string {
  return ((hi - lo) * 100).toFixed(2);
}

function labelFor(k: 'hazard' | 'loss' | 'held'): string {
  return k === 'hazard' ? 'hazard class' : k === 'held' ? 'barrier held' : 'production loss';
}

function Big({ label, value, unit, sub, tone }: {
  label: string; value: string; unit: string; sub?: string; tone?: 'good' | 'bad';
}) {
  const colour = tone === 'bad' ? 'text-vermillion' : tone === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <div className="border-l border-rule pl-3 leading-none">
      <div className="label">{label}</div>
      <div className={`readout mt-1 text-[26px] ${colour}`}>{value}</div>
      <div className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-ash">{unit}</div>
      {sub && <div className="mt-0.5 text-[10px] text-ash">{sub}</div>}
    </div>
  );
}

function Readout({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn';
}) {
  const colour = tone === 'bad' ? 'text-vermillion' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <div className="flex flex-col leading-tight">
      <span className="label">{label}</span>
      <span className={`readout text-[15px] ${colour}`}>{value}</span>
      {sub && <span className="text-[10px] text-ash">{sub}</span>}
    </div>
  );
}

/** Tail of the recorded shifts. Linear bins: the shape is the point, not the tail index. */
function Histogram({ recorded }: { recorded: { scn: number; costEur: number; outcome: string }[] }) {
  const W = 1160;
  const H = 132;
  if (!recorded.length) {
    return (
      <p className="mt-4 border border-rule px-3 py-6 text-center text-[11px] text-ash">
        The batch returned no shifts for replay, so there is nothing to histogram. Every bar on this chart is a
        shift that actually happened; none are invented to fill the axis.
      </p>
    );
  }
  const max = Math.max(...recorded.map((r) => r.costEur), 1);
  const bins = 14;
  const counts = new Array<number>(bins).fill(0);
  for (const r of recorded) {
    const i = Math.min(bins - 1, Math.floor((r.costEur / max) * bins));
    counts[i] += 1;
  }
  const peakCount = Math.max(...counts, 1);
  const bw = W / bins;

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${W} ${H + 24}`} className="w-full"
        role="img" aria-label="Histogram of per-shift consequence cost across the recorded shifts">
        {counts.map((c, i) => {
          const h = (c / peakCount) * H;
          const lo = (i / bins) * max;
          const hi = ((i + 1) / bins) * max;
          const inBin = recorded.filter((r) => r.costEur >= lo && r.costEur < hi);
          const hazard = inBin.some((b) => kindOfOutcome(b.outcome) === 'hazard');
          return (
            <g key={`bin-${i}`}>
              <rect x={i * bw + 1} y={H - h} width={bw - 2} height={h}
                fill={hazard ? '#ff4a2f' : '#ffb03a'} opacity={c ? 0.78 : 0} />
              {c > 0 && (
                <text x={i * bw + bw / 2} y={H - h - 4} textAnchor="middle" fontSize="9" fill="#e8e4dc">{c}</text>
              )}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H} y2={H} stroke="#232a34" />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={`tick-${f}`} x={f * W} y={H + 15} textAnchor={f === 1 ? 'end' : 'start'} fontSize="9" fill="#8a95a3">
            {eur(f * max)}
          </text>
        ))}
      </svg>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-ash">
        vermillion where a recorded shift in that bin was a hazard class, amber where it was a production loss
      </p>
    </div>
  );
}

/** The 95% CI of the MEAN, drawn as whiskers. Not a range of individual shifts. */
function CiWhisker({ ci }: { ci: { mean: number; ciLow: number; ciHigh: number } }) {
  const span = Math.max(1, ci.ciHigh - ci.ciLow);
  const axisLo = Math.max(0, ci.ciLow - span);
  const axisHi = ci.ciHigh + span;
  const at = (v: number) => `${((v - axisLo) / Math.max(1e-9, axisHi - axisLo)) * 100}%`;
  return (
    <div className="flex flex-col leading-tight">
      <span className="label">95% CI of the mean</span>
      <div className="relative mt-2 h-[16px] w-[220px]">
        <div className="absolute top-1/2 h-[1px] w-full bg-ash/60" />
        <div className="absolute top-1/2 h-[9px] w-[1px] bg-ash" style={{ left: at(ci.ciLow) }} />
        <div className="absolute top-1/2 h-[9px] w-[1px] bg-ash" style={{ left: at(ci.ciHigh) }} />
        <div className="absolute top-1/2 h-[1px] bg-cyan" style={{ left: at(ci.ciLow), width: `calc(${at(ci.ciHigh)} - ${at(ci.ciLow)})` }} />
        <div className="absolute top-1/2 h-[13px] w-[3px] -translate-y-1/2 bg-cyan" style={{ left: at(ci.mean) }} />
      </div>
      <span className="readout mt-1 text-[12px] text-cyan">
        {eur(ci.mean)} - [{eur(ci.ciLow)}, {eur(ci.ciHigh)}]
      </span>
    </div>
  );
}

function engineLine(
  where: 'worker' | 'amd' | 'node' | null,
  device: string | undefined,
  amdReachable: boolean,
): { headline: string; note: string; tone: string } {
  if (where === 'amd') {
    return {
      headline: 'AMD INSTINCT',
      tone: 'border-phosphor/40 bg-phosphor/8 text-phosphor',
      note: `The batched tensor kernel answered this run${device ? ` on ${device}` : ''}. It is an independent re-implementation of the same model, held to the same golden fixtures as the browser and node engines.`,
    };
  }
  if (where === 'node') {
    return {
      headline: 'NODE KERNEL, SERVER',
      tone: 'border-amber/40 bg-amber/8 text-amber',
      note: 'The server answered this batch with the loop kernel, not an accelerator. No GPU claim is being made about the numbers below.',
    };
  }
  if (where === 'worker') {
    return {
      headline: 'BROWSER WORKER - NOT THE GPU',
      tone: 'border-vermillion/40 bg-vermillion/8 text-vermillion',
      note: `These figures came from the same Monte-Carlo kernel running in a Web Worker on this machine${
        amdReachable ? ' while an AMD Instinct service was reachable but unused for this batch' : ', because no AMD Instinct service is attached to this deployment'
      }. Nothing here used a GPU, and the throughput above is a laptop number.`,
    };
  }
  return {
    headline: 'NO ENGINE HAS ANSWERED YET',
    tone: 'border-rule text-ash',
    note: 'Run a batch and this line records which machine produced the numbers, including when the GPU was not it.',
  };
}
