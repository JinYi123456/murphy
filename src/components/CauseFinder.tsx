'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { RESOLUTION } from '../lib/diagnosis';
import bench from '../../data/bench/diagnosis.json';

const WINDOWS = [
  { v: 900, label: '15 min' },
  { v: 2400, label: '40 min' },
  { v: 4200, label: 'whole heat' },
];

const pct = (v: number) => (v > 0.999 ? '>99.9%' : v < 0.0005 ? '<0.1%' : `${(v * 100).toFixed(v >= 0.0995 ? 0 : 1)}%`);

/** One channel of the window, drawn as increments so an unknown start level and
 *  a constant gauge offset both cancel - the two things a real diagnostician
 *  does not know. */
function Trace({ series, tS, name, sigma }: { series: number[]; tS: number[]; name: string; sigma: number }) {
  const w = 300;
  const h = 46;
  const inc = series.map((v) => v - (series[0] ?? 0));
  const span = Math.max(1e-6, ...inc.map((v) => Math.abs(v)));
  const pts = inc
    .map((v, i) => `${((i / Math.max(1, inc.length - 1)) * w).toFixed(1)},${(h / 2 - (v / span) * (h / 2 - 3)).toFixed(1)}`)
    .join(' ');
  const moved = inc.length > 1 ? Math.abs(inc[inc.length - 1] - inc[Math.floor(inc.length / 2)]) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="label w-[70px] shrink-0">{name}</span>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[46px] w-[300px] shrink-0" role="img" aria-label={`${name} over the window`}>
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} stroke="var(--color-rule)" strokeWidth="1" />
        <polyline points={pts} fill="none" stroke={moved > sigma ? 'var(--color-amber)' : 'var(--color-ash)'} strokeWidth="1.4" />
      </svg>
      <span className="readout text-[11px] text-ash">+/-{(span).toFixed(span > 10 ? 0 : 2)}</span>
    </div>
  );
}

/**
 * The question a control room actually asks.
 *
 * Everything else in this app goes forward - procedure in, failures out. This
 * screen runs it backwards: here is an instrument window, which of the
 * procedure's own error modes would have produced it? The answer is split in two
 * on purpose. First, whether the window contradicts a shift performed as
 * written at all; most procedural failures never reach a sensor, and a tool that
 * skips that question and goes straight to a ranking is guessing. Only then,
 * conditional on something being visible, which one.
 *
 * The recording knows what really happened because the simulator wrote it. The
 * ranker is not told, and the truth is revealed underneath the ranking so the
 * claim can be checked rather than admired.
 */
export function CauseFinder({ s }: { s: ConsoleStore }) {
  const candidates = useMemo(
    () => s.traced.filter((t) => t.errors.length > 0),
    [s.traced],
  );
  const [scn, setScn] = useState<number | null>(null);
  const [errIdx, setErrIdx] = useState(0);
  const [windowS, setWindowS] = useState(2400);
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    if (candidates.length && (scn === null || !candidates.some((c) => c.scn === scn))) {
      setScn(candidates[0].scn);
      setErrIdx(0);
    }
  }, [candidates, scn]);

  useEffect(() => {
    if (scn === null || s.diag.running) return;
    if (s.diagnosis && s.diagnosis.scn === scn && s.diagnosis.windowS === windowS) return;
    void s.runDiagnosis(scn, errIdx, { windowS, replicas: 6 });
    // the store guards its own in-flight request; re-running on the same inputs
    // would only recompute an identical answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scn, errIdx, windowS]);

  const c = s.diagnosis;
  const clean = c?.diagnosis.hypotheses.find((h) => h.errorId === 'clean');
  const pWrong = clean ? Math.max(0, 1 - clean.posterior) : 0;
  const ranked = (c?.diagnosis.hypotheses ?? []).filter((h) => h.errorId !== 'clean');
  const all = c?.diagnosis.hypotheses ?? [];
  const margin = all.length > 1 ? Math.max(0, all[0].logScore - all[1].logScore) : 0;
  const cond = (p: number) => (pWrong > 1e-9 ? p / pWrong : 0);
  const truthIdx = candidates.findIndex((x) => x.scn === scn);
  const shift = truthIdx >= 0 ? candidates[truthIdx] : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex flex-col gap-4">
        <section className="panel p-4">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <label className="flex min-w-[220px] flex-col gap-1">
              <span className="label">recording</span>
              <select
                value={scn ?? ''}
                onChange={(e) => { setScn(Number(e.target.value)); setErrIdx(0); }}
                className="border border-rule bg-graphite px-2 py-1 text-[12px] text-bone outline-none focus:border-amber"
              >
                {candidates.map((t, i) => (
                  <option key={t.scn} value={t.scn}>
                    shift #{t.scn} - {t.outcome} ({t.errors.length} deviation{t.errors.length > 1 ? 's' : ''})
                  </option>
                ))}
                {!candidates.length && <option>nothing recorded a deviation</option>}
              </select>
            </label>
            <label className="flex min-w-[260px] flex-col gap-1">
              <span className="label">window the historian is holding</span>
              <div className="flex gap-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.v} onClick={() => setWindowS(w.v)}
                    className={`border px-3 py-1 text-[11px] uppercase tracking-[0.14em] ${windowS === w.v ? 'border-amber bg-amber/15 text-amber' : 'border-rule text-ash hover:border-ash hover:text-bone'}`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </label>
            {shift && shift.errors.length > 1 && (
              <fieldset className="flex min-w-[240px] flex-col gap-1 border-0 p-0">
                <legend className="label">which deviation the tape is from</legend>
                <select
                  value={errIdx}
                  onChange={(e) => setErrIdx(Number(e.target.value))}
                  className="border border-rule bg-graphite px-2 py-1 text-[12px] text-bone outline-none focus:border-amber"
                >
                  {shift.errors.map((er, i) => (
                    <option key={`${er.stepId}/${er.errorId}`} value={i}>
                      {er.stepId} - {er.kind} at {Math.round(er.atS / 60)} min
                    </option>
                  ))}
                </select>
              </fieldset>
            )}
          </div>

          <p className="mt-3 max-w-[900px] text-[12px] leading-relaxed text-ash">
            The ranker is given {c?.obs.tS.length ?? 0} readings of {c?.channels.map((ch) => ch.name).join(', ')} and the
            procedure. It is not given the answer. {c?.replicas ?? 0} replicas x {ranked.length + 1} candidates =
            {` ${(c?.replicas ?? 0) * (ranked.length + 1)} simulated shifts`} were run to produce this screen, in{' '}
            {((c?.ms ?? 0) / 1000).toFixed(1)} s.
          </p>
          {s.diag.error && <p className="mt-2 text-[12px] text-vermillion">{s.diag.error}</p>}
        </section>

        {/* stage one: is there anything to find at all */}
        <section className="panel p-4">
          <h3 className="label">1 - does the window contradict a shift performed as written?</h3>
          {!c && <p className="mt-3 text-[12px] text-ash">reading the tape...</p>}
          {c && (
            <>
              <div className="mt-3 flex flex-col gap-2">
                <Bar label="nothing went wrong" v={clean?.posterior ?? 0} tone="ash" />
                <Bar label="something in the procedure went wrong" v={pWrong} tone={pWrong > 0.5 ? 'vermillion' : 'ash'} />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                <Readout label="instrument movement this failure causes" value={`${c.divergence.toFixed(2)} sigma/sample`} />
                <Readout label="historian can resolve" value={`> ${RESOLUTION.toFixed(2)} sigma`} />
                <Readout label="margin over the runner-up" value={`${margin.toFixed(0)} nats`} />
                <Readout label="verdict" value={c.visible ? 'there is something to find' : 'below resolution'} tone={c.visible ? 'amber' : 'vermillion'} />
              </div>
              <p className="mt-3 max-w-[900px] text-[12px] leading-relaxed text-ash">
                {c.visible && pWrong > 0.5
                  ? 'The failure does move the instruments, and the window contradicts a shift performed as written. Ranking it against the other candidates is meaningful, and stage two below is worth reading.'
                  : c.visible
                    ? 'This failure would move the instruments on its own, but in this recording nothing in the window actually departs from a clean shift far enough to overturn the prior. The margin column shows how thin that disagreement is.'
                    : pWrong > 0.5
                      ? `The selected deviation moves the averaged traces by less than the scatter the historian has, yet the window still contradicts a clean shift: something else in this recording is visible, and the ranking below is the ranker's answer to what. That distinction - the tape says a mistake happened, not which mistake - is the whole reason stage one exists.`
                      : `Nothing in this window departs far enough from a shift performed as written to be diagnosable. ${pct(bench.observableShare)} of this procedure's ${bench.errorModes} error modes reach an instrument at all; this is not a weakness of the ranking arithmetic but of the instruments. A mistake of this class has to be caught by the procedure or by the interlock, because no panel will show it.`}
              </p>
            </>
          )}
        </section>

        {/* stage two: which one */}
        {c && (
          <section className="panel p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="label">2 - conditional on something being visible, which one</h3>
              <button
                onClick={() => setRevealed((r) => !r)}
                className="border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-ash hover:border-amber hover:text-amber"
              >
                {revealed ? 'hide the answer' : 'show what really happened'}
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              {ranked.slice(0, 9).map((h, i) => {
                const isTruth = revealed && h.id === c.truth;
                return (
                  <div key={h.id} className={`flex items-start gap-3 border-l-2 px-3 py-2 ${isTruth ? 'border-amber bg-amber/8' : 'border-rule'}`}>
                    <span className="readout w-6 shrink-0 text-[12px] text-ash">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[11px] uppercase tracking-[0.12em] text-bone">{h.stepId}</span>
                        <span className="text-[11px] text-ash">{h.stepTitle}</span>
                        <span className="text-[10px] uppercase tracking-[0.12em] text-amber">{h.errorKind}</span>
                      </div>
                      <p className="mt-0.5 text-[12px] leading-snug text-bone">{h.label}</p>
                      <div className="mt-1.5">
                        <Bar label="" v={cond(h.posterior)} tone={isTruth ? 'amber' : 'phosphor'} bare />
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="readout text-[13px] text-bone">{pct(cond(h.posterior))}</div>
                      <div className="text-[10px] text-ash">prior {h.prior.toExponential(1)}</div>
                      <div className="mt-1 text-[10px] text-ash">
                        residual {Object.entries(h.residual).slice(0, 2).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' / ')}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {revealed && (
              <p className="mt-3 text-[12px] text-ash">
                What really happened, from the recording:{' '}
                <span className="text-amber">{c.truth}</span> - {c.truthLabel} at minute {Math.round(c.truthAtS / 60)}.
                The ranker placed it <span className="readout text-[12px] text-bone">#{c.rank + 1}</span> of {ranked.length}.
              </p>
            )}
          </section>
        )}
      </div>

      <aside className="flex flex-col gap-4">
        <section className="panel p-4">
          <h3 className="label">the window, as increments</h3>
          <div className="mt-3 flex flex-col gap-2">
            {c?.channels.map((ch) => (
              <Trace key={ch.name} name={ch.name} series={c.obs.values[ch.name] ?? []} tS={c.obs.tS} sigma={ch.sigma} />
            ))}
            {!c && <p className="text-[12px] text-ash">reading the tape...</p>}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ash">
            Differenced from the first reading of the window, so an unknown start level and a constant gauge offset
            both cancel. The offset in this plant state is itself a modelled condition.
          </p>
        </section>

        <section className="panel p-4">
          <h3 className="label">how often this ranking is right</h3>
          <p className="mt-2 text-[11px] text-ash">
            Not one anecdote: every visible error mode of {bench.procedure} on {bench.plant} was used as a truth in
            turn, {bench.replicas} replicas, {bench.errorModes} candidates.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Readout label="top-1" value={pct(bench.top1)} tone="amber" />
            <Readout label="chance top-1" value={pct(bench.chanceTop1)} />
            <Readout label="inside top-3" value={pct(bench.top3)} tone="phosphor" />
            <Readout label="lift over chance" value={`${bench.lift.toFixed(1)}x`} tone="phosphor" />
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="label">observable modes</span>
              <span className="readout text-[13px] text-bone">{bench.observable} / {bench.errorModes}</span>
            </div>
            <Bar label="" v={bench.observableShare} tone="ash" bare />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-ash">
            {pct(1 - bench.observableShare)} of the ways this procedure can fail produce no instrument signature at
            all. Accuracy is quoted only over the {bench.observable} that do; a figure over the whole set would be a
            guess about the invisible half.
          </p>
        </section>

        <section className="panel p-4">
          <h3 className="label">what this cannot tell you</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-ash">
            <li>Two error modes that produce the same trajectory are given the same score and split by prior alone - that is why d10's three variants sit within a few points of each other.</li>
            <li>The window is scored against a model that is, by construction, the same model that produced the observation. The benchmark is a check of the ranking arithmetic, not of the physics.</li>
            <li>Samples in a trajectory are autocorrelated. The score divides the effective sample count by a stated decorrelation time instead of pretending 160 readings are 160 independent ones.</li>
            <li>A posterior here is a degree of belief given this model and this prior, not a frequency you can bet on.</li>
            <li>The margin in nats is how much the model prefers one candidate. It is not a calibration: the calibrated figure is the {pct(bench.top1)} top-1 rate measured over all visible modes, and a single case showing {`>`}99.9% is the model being sure of itself, which is exactly why this panel puts the two numbers on the same screen.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function Bar({ label, v, tone, bare }: { label: string; v: number; tone: 'amber' | 'phosphor' | 'vermillion' | 'ash'; bare?: boolean }) {
  const colour = tone === 'amber' ? 'bg-amber' : tone === 'phosphor' ? 'bg-phosphor' : tone === 'vermillion' ? 'bg-vermillion' : 'bg-ash';
  return (
    <div className="flex items-center gap-3">
      {!bare && <span className="label w-[260px] shrink-0">{label}</span>}
      <div className="h-[10px] flex-1 border border-rule bg-graphite">
        <div className={`h-full ${colour}`} style={{ width: `${Math.max(0.5, Math.min(100, v * 100)).toFixed(1)}%` }} />
      </div>
      {!bare && <span className="readout w-[52px] shrink-0 text-right text-[12px] text-bone">{pct(v)}</span>}
    </div>
  );
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: 'amber' | 'phosphor' | 'vermillion' }) {
  const colour = tone === 'amber' ? 'text-amber' : tone === 'phosphor' ? 'text-phosphor' : tone === 'vermillion' ? 'text-vermillion' : 'text-bone';
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className={`readout text-[13px] ${colour}`}>{value}</span>
    </div>
  );
}
