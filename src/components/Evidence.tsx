'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { PROCEDURES } from '../lib/registry';
import { conditionUsage, inspectModel } from '../engine/model';
import { ALL_CONDITIONS } from '../engine/conditions';
import { getTwin } from '../engine/twins/index';
import { gpuHealth } from '../lib/gpu';
import type { GpuHealth } from '../lib/gpu';

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;

/** Presence states are rendered, never echoed. Nothing here prints a value from the environment. */
const ENV_NAMES = ['AMD_GPU_URL', 'EVOLUS_API_KEY', 'EVOLUS_APP_ID'];

/** Commands read out of package.json and scripts/ in this checkout, verbatim. */
const COMMANDS = [
  { cmd: 'npm ci', what: 'install the exact dependency set from package-lock.json' },
  { cmd: 'npm run dev', what: 'start the console on http://localhost:3000' },
  { cmd: 'npm test', what: 'vitest run - the engine and simulation suites' },
  { cmd: 'npm run golden', what: 'regenerate data/golden: the fixtures the GPU engine is held against' },
  { cmd: 'npm run typecheck', what: 'tsc --noEmit under strict mode' },
  { cmd: 'npm run smoke', what: 'every crew against every compatible plant state' },
  { cmd: 'uvicorn murphy_gpu.api:app', what: 'the batched engine service, started from services/gpu' },
];

interface BenchRow {
  label?: string;
  device?: string;
  n?: number;
  wallMs?: number;
  shiftsPerSecond?: number;
}

interface BenchState {
  state: 'loading' | 'ready' | 'absent' | 'failed';
  rows: BenchRow[];
  message: string;
}

/**
 * Evidence: what ran, where, at what cost, and what this thing is not.
 *
 * This screen exists so that nobody has to take the rest of the product on
 * trust. It names the machine that answered, the commands that reproduce the
 * number, the model's own integrity report, the measured throughput of every
 * engine, and the four things MURPHY cannot do. Anything that has not been
 * captured is written as missing rather than filled in with a plausible figure.
 */
export function Evidence({ s }: { s: ConsoleStore }) {
  const [bench, setBench] = useState<BenchState>({ state: 'loading', rows: [], message: '' });
  const [probe, setProbe] = useState<GpuHealth | null>(null);
  const [probing, setProbing] = useState(false);
  const probeToken = useRef(0);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setBench({ state: 'loading', rows: [], message: '' });
    fetch('/api/bench', { signal: ac.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setBench({
            state: 'absent',
            rows: [],
            message: `no benchmark has been captured yet: the route answered HTTP ${res.status}, so nothing is reading cpu_vs_amd for this build`,
          });
          return;
        }
        const text = await res.text();
        if (cancelled) return;
        try {
          const doc = JSON.parse(text) as { rows?: BenchRow[] };
          const rows = Array.isArray(doc.rows) ? doc.rows : [];
          setBench(rows.length
            ? { state: 'ready', rows, message: '' }
            : { state: 'absent', rows: [], message: 'the benchmark route answered but carried no rows' });
        } catch {
          setBench({ state: 'failed', rows: [], message: 'the benchmark route returned something that is not a benchmark document' });
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBench({ state: 'absent', rows: [], message: `no benchmark route is served yet (${(e as Error).message})` });
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  /** Lazy: a probe is a real network round trip to a machine that may not exist. */
  const reProbe = useCallback(() => {
    const my = ++probeToken.current;
    setProbing(true);
    void gpuHealth().then((h) => {
      if (probeToken.current === my) { setProbe(h); setProbing(false); }
    });
  }, []);

  const integrity = useMemo(() => PROCEDURES.map((p) => {
    const report = inspectModel(p);
    const twin = getTwin(p.twin);
    const usage = conditionUsage([p]);
    const keys = new Set<string>();
    for (const st of p.steps) for (const k of Object.keys(st.applies ?? {})) keys.add(k);
    const resolved = [...keys].filter((k) => twin.discIndex(k) >= 0 || twin.varIndex(k) >= 0);
    return {
      procedure: p,
      ok: report.ok,
      errors: report.errors,
      notes: report.notes,
      steps: p.steps.length,
      errorModes: p.steps.reduce((a, b) => a + (b.errors?.length ?? 0), 0),
      stepsWithError: p.steps.filter((st) => (st.errors?.length ?? 0) > 0).length,
      conditionsUsed: Object.values(usage).filter((v) => v > 0).length,
      variablesTouched: resolved.length,
      variablesUnknown: keys.size - resolved.length,
      twinVars: twin.vars.length,
      twinDiscs: twin.discs.length,
      warnings: p.warnings?.length ?? 0,
    };
  }), []);

  const health = s.health;
  // absent until the health route answers; every branch below is guarded so these
  // fallbacks only ever satisfy the type checker, never the screen
  const amd = health?.backends.amd ?? { reachable: false, error: 'the health route has not answered' };
  const llm = health?.backends.llm ?? { configured: false, note: 'the health route has not answered' };
  const evolus = health?.backends.evolus ?? { configured: false };
  const source = s.where;

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Evidence</h2>
          <p className="text-[12px] text-ash">what ran, where, at what cost - and what this thing is not</p>
          <button onClick={() => window.print()}
            className="no-print ml-auto border border-amber bg-amber/12 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-amber hover:bg-amber/25">
            print this sheet
          </button>
        </div>
        <p className="mt-2 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          Print sends the marked sheets on this page and in the change lab to paper; the interactive chrome
          carries a no-print class. It prints through the console header, which this screen does not own.
        </p>
      </section>

      {/* ------------------------------------------------------------- backends */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Engines attached</h3>
        <p className="mt-1 text-[11px] text-ash">
          presence only. no key, token, cookie or environment value is read, displayed or masked on this screen.
        </p>

        {!health ? (
          <p className="mt-3 border border-vermillion/40 bg-vermillion/8 px-3 py-2 text-[11px] text-vermillion">
            /api/health has not answered, so nothing on this panel is known. It is not the same as being absent.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div className={`border p-3 ${amd.reachable ? 'border-phosphor/40' : 'border-rule'}`}>
              <div className="flex items-baseline gap-2">
                <Dot ok={amd.reachable} />
                <span className="text-[11px] uppercase tracking-[0.16em] text-bone">amd instinct batched engine</span>
              </div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <Row k="reachable" v={amd.reachable ? 'yes' : 'no'} tone={amd.reachable ? 'good' : 'bad'} />
                <Row k="device" v={amd.device ?? 'not reported'} />
                <Row k="torch" v={amd.torch ?? 'not reported'} />
                <Row k="hip" v={amd.hip ?? 'not reported'} />
                <Row k="probe latency" v={amd.latencyMs !== undefined ? `${amd.latencyMs.toFixed(0)} ms` : 'not measured'} />
                <Row k="absent because" v={amd.error ?? 'none reported'} tone={amd.error ? 'bad' : 'neutral'} />
              </dl>
              <button onClick={reProbe} disabled={probing}
                className="no-print mt-2 border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-ash hover:border-amber hover:text-amber disabled:opacity-40">
                {probing ? 'probing' : 're-probe now'}
              </button>
              {probe && (
                <p className="mt-2 text-[10px] leading-relaxed text-ash">
                  live probe: {probe.reachable ? `reachable, ${probe.device ?? 'device not named'}, ${probe.latencyMs?.toFixed(0) ?? '-'} ms round trip` : `not reachable - ${probe.error ?? 'no reason given'}`}
                </p>
              )}
            </div>

            <div className={`border p-3 ${llm.configured ? 'border-phosphor/40' : 'border-rule'}`}>
              <div className="flex items-baseline gap-2">
                <Dot ok={llm.configured} />
                <span className="text-[11px] uppercase tracking-[0.16em] text-bone">open model service</span>
              </div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <Row k="configured" v={llm.configured ? 'yes' : 'no'} tone={llm.configured ? 'good' : 'bad'} />
                <Row k="model" v={llm.model ?? 'not reported'} />
                <Row k="endpoint" v={llm.endpoint ?? 'not reported'} />
                <Row k="note" v={llm.note ?? 'none'} />
              </dl>
              <p className="mt-2 text-[10px] leading-relaxed text-ash">
                the model is a reader and a drafter, never a calculator: no figure anywhere in this product is
                produced by asking it.
              </p>
            </div>

            <div className={`border p-3 ${evolus.configured ? 'border-phosphor/40' : 'border-rule'}`}>
              <div className="flex items-baseline gap-2">
                <Dot ok={evolus.configured} />
                <span className="text-[11px] uppercase tracking-[0.16em] text-bone">evolus workflows</span>
              </div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <Row k="configured" v={evolus.configured ? 'yes' : 'no'} tone={evolus.configured ? 'good' : 'bad'} />
                <Row k="credential variables" v={ENV_NAMES.slice(1).join(', ')} />
              </dl>
              <p className="mt-2 text-[10px] leading-relaxed text-ash">
                document extraction and knowledge workflows. presence is all this panel is allowed to report.
              </p>
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-rule pt-3">
          <span className="label">which engine answered the numbers on the other screens</span>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-[11px]">
            <dl className="contents">
              <Row k="this batch" v={source === null ? 'no run in this session' : source === 'amd' ? `AMD Instinct${s.device ? ` (${s.device})` : ''}` : source === 'node' ? 'node kernel on the server' : 'browser worker on this machine'}
                tone={source === 'amd' ? 'good' : source === null ? 'bad' : 'warn'} />
              <Row k="variant under test" v={s.label} />
              <Row k="method" v={s.cfg.method.toUpperCase()} />
              <Row k="seed" v={s.cfg.seed} />
            </dl>
          </div>
          {source !== 'amd' && (
            <p className="mt-2 text-[10px] leading-relaxed text-vermillion">
              the accelerator did not answer this session. every figure in the product right now came from the
              loop kernel, and the throughput claims are laptop throughput.
            </p>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------------- reproduce */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">How to reproduce</h3>
        <p className="mt-1 text-[11px] text-ash">
          commands and variable names read from package.json and the source of this checkout. run them and you
          get the same numbers, because the kernel is deterministic in the seed.
        </p>
        <ul className="mt-3 grid gap-1.5">
          {COMMANDS.map((c) => (
            <li key={c.cmd} className="flex flex-wrap items-baseline gap-x-4 border-l border-rule pl-3">
              <code className="readout text-[12px] text-amber">{c.cmd}</code>
              <span className="text-[11px] text-ash">{c.what}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="label">environment variables read by the server</span>
          {ENV_NAMES.map((n) => (
            <code key={n} className="readout border border-rule bg-void px-2 py-1 text-[11px] text-cyan">{n}</code>
          ))}
        </div>
        <p className="mt-2 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          the variable names above are the ones this checkout actually reads; the model service reads its own
          through the llm client module, and this screen reports only whether it is configured. values are
          never printed, even masked. container: no Dockerfile is present in this checkout, so there is no
          container command to give - the service is started with the uvicorn line above, and this row will
          read from the file when one lands.
        </p>
      </section>

      {/* ------------------------------------------------------- cost accounting */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">What this session cost</h3>
        {s.summary ? (
          <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
            <Figure label="shifts simulated" value={s.summary.n.toLocaleString('en-US')} />
            <Figure label="engine wall time" value={`${(s.summary.wallMs / 1000).toFixed(2)} s`} />
            <Figure label="measured here" value={`${(s.elapsedMs / 1000).toFixed(2)} s`} />
            <Figure label="throughput" value={`${s.summary.shiftsPerSecond.toLocaleString('en-US', { maximumFractionDigits: 0 })} /s`} />
            <Figure label="modelled exposure" value={`${eur(s.summary.annualLossEur)}/yr`} tone="bad" />
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-ash">No run has completed in this session, so there is no compute cost to report.</p>
        )}

        <div className="mt-4 border border-rule bg-void px-3 py-2">
          <span className="label">tokens and model latency</span>
          <p className="mt-1 text-[11px] leading-relaxed text-bone">
            No model call is recorded on this session's state. The console store carries no token count, no
            completion and no billed request from any route, so there is nothing to total on this line and
            nothing is estimated: every figure on the other four screens came from the deterministic kernel and
            the paired bootstrap. The model service itself is reported by presence in the panel above; if a
            model-backed route is later attached to the store, its token and latency accounting appears here as
            measured data rather than as a claim.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------ model integrity */}
      <section className="print-sheet panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Model integrity</h3>
        <p className="mt-1 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          Every procedure is re-validated in the browser with the same gate the server runs: step ids unique,
          kinds and cues from the published vocabularies, weights non-negative, and no patch that names a
          variable the twin does not have. An unknown variable is not a warning here - it is the difference
          between a finding and a fiction.
        </p>

        {!health ? (
          <p className="mt-3 text-[11px] text-ash">The health route has not answered, so there is no declared model catalogue to check the bundle against.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left uppercase tracking-[0.12em] text-ash">
                  <th className="pr-3 font-normal">procedure</th>
                  <th className="pr-3 text-right font-normal">steps</th>
                  <th className="pr-3 text-right font-normal">error modes</th>
                  <th className="pr-3 text-right font-normal">conditions used</th>
                  <th className="pr-3 text-right font-normal">plant variables touched</th>
                  <th className="pr-3 font-normal">gate</th>
                  <th className="font-normal">server says</th>
                </tr>
              </thead>
              <tbody>
                {integrity.map((r) => {
                  const declared = health.model.procedures.find((p) => p.id === r.procedure.id);
                  const agrees = !!declared
                    && declared.steps === r.steps
                    && declared.integrity === r.ok
                    && declared.warnings === r.warnings;
                  return (
                    <tr key={r.procedure.id} className="border-t border-rule align-top">
                      <td className="py-2 pr-3">
                        <div className="text-bone">{r.procedure.id} rev {r.procedure.revision}</div>
                        <div className="text-[10px] text-ash">{r.procedure.title}</div>
                        <div className="text-[10px] text-ash">twin {r.procedure.twin} - {r.twinVars} process variables, {r.twinDiscs} scenario states</div>
                      </td>
                      <td className="py-2 pr-3 text-right readout text-bone">{r.steps}</td>
                      <td className="py-2 pr-3 text-right readout text-bone">
                        {r.errorModes}
                        <div className="text-[10px] text-ash">{r.stepsWithError} steps carry a surface</div>
                      </td>
                      <td className="py-2 pr-3 text-right readout text-bone">
                        {r.conditionsUsed} of {ALL_CONDITIONS.length}
                      </td>
                      <td className="py-2 pr-3 text-right readout text-bone">
                        {r.variablesTouched}
                        {r.variablesUnknown > 0 && <div className="text-[10px] text-vermillion">{r.variablesUnknown} unknown to the twin</div>}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] ${r.ok ? 'border-phosphor/50 text-phosphor' : 'border-vermillion/50 text-vermillion'}`}>
                          {r.ok ? 'pass' : 'fail'}
                        </span>
                        {r.notes.map((n) => <div key={n} className="mt-1 text-[10px] text-ash">{n}</div>)}
                        {r.errors.map((e) => <div key={e} className="mt-1 text-[10px] text-vermillion">{e}</div>)}
                      </td>
                      <td className="py-2">
                        {declared ? (
                          <span className={agrees ? 'text-phosphor' : 'text-vermillion'}>
                            {agrees
                              ? `agrees: ${declared.steps} steps, integrity ${declared.integrity ? 'pass' : 'fail'}, ${declared.warnings} warnings`
                              : `MISMATCH - server declares ${declared.steps} steps and integrity ${declared.integrity ? 'pass' : 'fail'}`}
                          </span>
                        ) : <span className="text-ash">not in the server catalogue</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {health && (
          <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-[11px]">
            <Row k="crews modelled" v={String(health.model.personas.length)} />
            <Row k="plant states" v={String(health.model.plants.length)} />
            <Row k="twins" v={health.model.twins.map((t) => `${t.id} (${t.hazardKind})`).join(', ')} />
            <Row k="hra methods" v={health.model.methods.join(', ')} />
            <Row k="conditions in the catalogue" v={String(ALL_CONDITIONS.length)} />
            {health.model.controls.length > 0 && (
              <Row k="controls in catalogue"
                v={`${health.model.controls.length}, from ${eur(Math.min(...health.model.controls.map((c) => c.annualCostEur)))} to ${eur(Math.max(...health.model.controls.map((c) => c.annualCostEur)))} a year`} />
            )}
          </dl>
        )}
      </section>

      {/* ----------------------------------------------------------- benchmarks */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Benchmarks, cpu against amd</h3>
        {bench.state === 'loading' && <p className="mt-2 text-[11px] text-amber">asking the benchmark route...</p>}
        {bench.state === 'absent' && (
          <div className="mt-2 border border-amber/40 bg-amber/8 px-3 py-3">
            <p className="text-[11px] uppercase tracking-[0.14em] text-amber">benchmark not captured yet</p>
            <p className="mt-1 max-w-[900px] text-[11px] leading-relaxed text-ash">
              {bench.message}. There are no placeholder numbers in this table on purpose: an unmeasured speedup
              is the one figure this screen must not invent. Capture it against a real Instinct card and the
              rows appear here.
            </p>
          </div>
        )}
        {bench.state === 'failed' && (
          <p className="mt-2 text-[11px] text-vermillion">{bench.message}</p>
        )}
        {bench.state === 'ready' && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left uppercase tracking-[0.12em] text-ash">
                  <th className="pr-3 font-normal">device</th>
                  <th className="pr-3 text-right font-normal">shifts</th>
                  <th className="pr-3 text-right font-normal">wall</th>
                  <th className="pr-3 text-right font-normal">shifts / s</th>
                </tr>
              </thead>
              <tbody>
                {bench.rows.map((r, i) => (
                  <tr key={`bm-${i}`} className="border-t border-rule">
                    <td className="py-1 pr-3 text-bone">{r.label ?? r.device ?? `row ${i}`}</td>
                    <td className="py-1 pr-3 text-right readout text-bone">{r.n?.toLocaleString('en-US') ?? '-'}</td>
                    <td className="py-1 pr-3 text-right readout text-bone">{r.wallMs !== undefined ? `${(r.wallMs / 1000).toFixed(2)} s` : '-'}</td>
                    <td className="py-1 pr-3 text-right readout text-cyan">{r.shiftsPerSecond?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          What is measured today: the browser worker and the node engine ran the same kernel on the same seeds
          as the batched tensor implementation, and data/golden holds the fixtures all three are checked
          against. A throughput claim that has not been made against a card is not made here.
        </p>
      </section>

      {/* ---------------------------------------------------------- limitations */}
      <section className="print-sheet panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.2em] text-vermillion">What this is not</h3>
        <ul className="mt-3 space-y-3 text-[12px] leading-relaxed text-bone">
          <li className="border-l-2 border-vermillion pl-3">
            <span className="text-vermillion">Human reliability base rates are order-of-magnitude screening values.</span>{' '}
            They come from published tables written in the 1980s for reactor control rooms. The band on a step
            is typically a factor of three to ten either side of the point, and the point is not a forecast.
          </li>
          <li className="border-l-2 border-vermillion pl-3">
            <span className="text-vermillion">The process models are engineered surrogates.</span>{' '}
            The tank and the furnace are mass, energy and pressure balances written from published incident
            mechanics and checked against the incident record - not computational fluid dynamics, and not a
            substitute for a site-specific consequence study.
          </li>
          <li className="border-l-2 border-vermillion pl-3">
            <span className="text-vermillion">A simulated crew is a hypothesis about a crew.</span>{' '}
            Six personas stand in for the range of people who actually do this work. Their failure rate is
            your plant's rate only if your plant contains crews like them, and you should replace them with
            your own shift data before believing a number.
          </li>
          <li className="border-l-2 border-vermillion pl-3">
            <span className="text-vermillion">Every change order needs a human signature.</span>{' '}
            Nothing in the change lab is authority to change a controlled document. The paired test says which
            edit is worth arguing for; a competent person, on site, decides whether to make it.
          </li>
        </ul>
        <p className="mt-4 border border-vermillion/40 bg-vermillion/8 px-3 py-2 text-[13px] leading-relaxed text-vermillion">
          MURPHY is a prioritisation instrument, not a probability forecast.
        </p>
        <p className="mt-3 text-[11px] leading-relaxed text-ash">
          A finding here is a hypothesis worth going to look at, in the order the model says to look, with the
          size of the prize attached. It is not a number to put in a safety case.
        </p>
        <div className="mt-5 grid gap-6 sm:grid-cols-3">
          {['evidence reviewed by', 'site data substituted by', 'accepted for action by'].map((r) => (
            <div key={r}>
              <div className="h-[30px] border-b border-ash/60" />
              <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ash">{r}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  const colour = ok ? '#3ee08f' : '#ff4a2f';
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: colour }} />;
}

function Row({ k, v, tone = 'neutral' }: { k: string; v: string; tone?: 'good' | 'bad' | 'warn' | 'neutral' }) {
  const colour = tone === 'good' ? 'text-phosphor' : tone === 'bad' ? 'text-vermillion' : tone === 'warn' ? 'text-amber' : 'text-bone';
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <dt className="label">{k}</dt>
      <dd className={`readout ${colour}`}>{v}</dd>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  const colour = tone === 'bad' ? 'text-vermillion' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <div className="flex flex-col leading-tight">
      <span className="label">{label}</span>
      <span className={`readout text-[17px] ${colour}`}>{value}</span>
    </div>
  );
}
