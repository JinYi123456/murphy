'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { CONTROL_CATALOGUE, procedureById, PERSONAS, PLANTS } from '../lib/registry';
import { targetSteps } from '../engine/repair';
import type { ControlTier, Intervention } from '../engine/repair';
import type { CandidateTrial } from '../lib/fuzz';
import type { SummaryDto } from '../lib/dto';

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number, dp = 2) => `${(v * 100).toFixed(dp)}%`;
const pts = (v: number) => `${v >= 0 ? '+' : '-'}${Math.abs(v * 100).toFixed(2)} pts`;

/** Hierarchy of controls, strongest first. The order is the argument of this screen. */
const TIERS: { id: ControlTier; rank: string; note: string; strong: boolean }[] = [
  { id: 'substitution', rank: 'tier 1', note: 'removes the hazardous thing itself', strong: true },
  { id: 'engineering', rank: 'tier 2', note: 'changes the device or the plant so the error cannot be made', strong: true },
  { id: 'administrative', rank: 'tier 3', note: 'changes the paperwork and the field cue; the person still has to act', strong: false },
  { id: 'training', rank: 'tier 4', note: 'changes who is allowed to do it', strong: false },
  { id: 'organisational', rank: 'tier 5', note: 'changes the schedule and the communication - "be more careful" lives here', strong: false },
];

const TIER_LABEL: Record<ControlTier, string> = {
  substitution: 'substitution',
  engineering: 'engineering',
  administrative: 'administrative',
  training: 'training',
  organisational: 'organisational',
};

/**
 * Change lab: the closed loop, and the graveyard of ideas that did not work.
 *
 * A control here is a typed mutation of the model, not a paragraph of advice,
 * which is the only reason the verdict means anything. Every candidate the
 * procedure admits is applied, the same scenario indices are re-run against it,
 * and the paired difference decides. Most candidates lose. That is the product:
 * a tool that only ever confirmed the idea you brought to it would be an
 * expensive way to avoid thinking.
 */
export function ChangeLab({ s }: { s: ConsoleStore }) {
  const tapeRef = useRef<HTMLDivElement | null>(null);
  const [pendingControls, setPendingControls] = useState<string[] | null>(null);

  const base = procedureById(s.cfg.procedureId);
  const catalogue = CONTROL_CATALOGUE;
  const total = catalogue.length;
  const done = Math.min(s.repair.trials.length, total);
  const candidateN = Math.min(s.cfg.n, 6000);

  useEffect(() => {
    const el = tapeRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.repair.log.length]);

  /**
   * Loading a stacked variant is a store write, so the re-run is deferred to
   * after the commit - calling s.run() in the same tick would fuzz the old
   * configuration.
   */
  useEffect(() => {
    if (!pendingControls) return;
    if (s.running) return;
    if (pendingControls.join('|') !== s.cfg.controls.join('|')) return;
    setPendingControls(null);
    void s.run({ onAmd: false });
  }, [pendingControls, s]);

  const grouped = useMemo(() => TIERS.map((t) => ({
    tier: t,
    items: catalogue.filter((c) => c.tier === t.id),
  })).filter((g) => g.items.length > 0), [catalogue]);

  const active = new Set(s.cfg.controls);

  return (
    <div className="grid gap-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Change lab</h2>
          <p className="text-[12px] text-ash">
            {base.id} rev {base.revision} - {PERSONAS.find((p) => p.id === s.cfg.personaId)?.label ?? s.cfg.personaId} -{' '}
            {PLANTS.find((p) => p.id === s.cfg.plantId)?.label ?? s.cfg.plantId} - {s.cfg.method.toUpperCase()}
          </p>
          {s.dirty && (
            <span className="border border-amber/40 bg-amber/8 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-amber">
              model changed - results below are from {s.summary?.variantId ?? 'no run'}
            </span>
          )}
        </div>

        <p className="mt-2 max-w-[1000px] text-[11px] leading-relaxed text-ash">
          Pick the controls you want tested, then run the loop. Each candidate is applied to the model, the
          same {candidateN.toLocaleString('en-US')} scenario indices are re-run against it, and a paired
          bootstrap plus false-discovery correction decide. The strongest controls are at the top because a
          device that cannot be operated wrongly is worth more than a person trying harder, and the model has
          to be able to say so.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button onClick={() => s.run({ onAmd: false })} disabled={s.running}
            className="border border-rule bg-panel px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-bone enabled:hover:border-amber disabled:opacity-40">
            {s.running ? 'running' : s.dirty ? 're-run this model' : 're-run'}
          </button>
          <button onClick={() => void s.runRepair()} disabled={s.running || s.repair.running}
            className="border border-amber bg-amber/12 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-amber enabled:hover:bg-amber/25 disabled:opacity-40">
            {s.repair.running ? 'repair loop running' : 'run the repair loop'}
          </button>
          <span className="readout text-[11px] text-ash">
            {s.repair.running ? `${done}/${total} candidates` : s.repair.trials.length ? `${s.repair.trials.length} tested` : `${total} candidates in the catalogue`}
          </span>
          {s.cfg.controls.length > 0 && (
            <button onClick={() => s.setCfg({ controls: [] })} disabled={s.running}
              className="ml-auto border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-ash hover:border-vermillion hover:text-vermillion disabled:opacity-40">
              clear {s.cfg.controls.length} selected
            </button>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ control picker */}
      <section className="no-print panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Candidate controls</h3>
        <p className="mt-1 text-[11px] text-ash">
          solid left edge and filled head: the error is engineered out. dashed edge: the fix depends on a
          person doing it correctly, which is the same resource the procedure already ran out of.
        </p>

        <div className="mt-4 space-y-5">
          {grouped.map(({ tier, items }) => (
            <div key={tier.id}>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule pb-1">
                <span className={`text-[11px] uppercase tracking-[0.18em] ${tier.strong ? 'text-phosphor' : 'text-ash'}`}>
                  {tier.rank} - {TIER_LABEL[tier.id]}
                </span>
                <span className="text-[11px] text-ash">{tier.note}</span>
              </div>
              <div className={`mt-2 grid gap-2 ${tier.strong ? 'lg:grid-cols-2' : 'lg:grid-cols-3'}`}>
                {items.map((c) => (
                  <ControlCard key={c.id} c={c} procedure={base} strong={tier.strong}
                    on={active.has(c.id)} disabled={s.running}
                    onToggle={() => s.toggleControl(c.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- tape */}
      <section className="no-print panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Repair loop, live</h3>
          <p className="text-[11px] text-ash">ndjson events as they arrive from the server</p>
          <span className="ml-auto readout text-[11px] text-ash">
            {s.repair.running ? `${done} / ${total}` : s.repair.trials.length ? 'complete' : 'idle'}
          </span>
        </div>
        <div className="mt-1 h-[3px] w-full bg-rule">
          <div className="h-full bg-amber" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>

        <div ref={tapeRef}
          className="mt-3 max-h-[190px] overflow-y-auto border border-rule bg-void px-3 py-2 text-[11px] leading-relaxed"
          aria-live="polite" aria-label="repair loop event tape">
          {s.repair.log.length === 0 ? (
            <p className="text-ash">
              {s.repair.trials.length
                ? 'Stream finished. The tape clears when the loop completes; the verdicts below are the same events.'
                : 'No events yet. The loop posts the baseline first, then one line per candidate as its paired test finishes.'}
            </p>
          ) : (
            s.repair.log.map((e, i) => (
              <p key={`tape-${i}`} className="whitespace-pre-wrap">
                <span className="text-ash">{String(i).padStart(2, '0')} </span>
                <span className={phaseColour(e.phase)}>{e.phase} </span>
                <span className="text-bone">{e.message}</span>
              </p>
            ))
          )}
        </div>
      </section>

      {/* --------------------------------------------------------------- trials */}
      <section className="panel p-4">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Every candidate, including the ones that lost</h3>
          <p className="text-[11px] text-ash">
            {s.repair.trials.length
              ? `${s.repair.trials.filter((t) => t.verdict?.accepted).length} accepted of ${s.repair.trials.length} tested`
              : 'nothing tested yet'}
          </p>
        </div>

        {!s.repair.trials.length && (
          <p className="mt-3 text-[11px] text-ash">
            Run the loop and each candidate appears here with its paired confidence interval and the reasons it
            was kept or thrown out. A rejection is shown at the same size as an acceptance on purpose.
          </p>
        )}

        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {s.repair.trials.map((t) => <TrialCard key={t.control.id} t={t} onStep={(id) => s.setSelectedStep(id)} />)}
        </div>
      </section>

      {/* ------------------------------------------------------------- stacked */}
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">The stacked variant</h3>
        {s.repair.stacked ? (
          (() => {
            const st = s.repair.stacked;
            const baseRate = s.repair.baseline?.failureRate ?? s.summary?.failureRate ?? 0;
            return (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-ash">
                  Controls interact, so the survivors are re-tested as one revised procedure rather than added
                  up. Without this step the loop would sell the same saving twice.
                </p>
                <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-4">
                  <Figure label="baseline failure" value={pct(baseRate)} />
                  <Figure label="stacked failure" value={pct(st.summary.failureRate)} tone={st.summary.failureRate < baseRate ? 'good' : 'bad'} />
                  <Figure label="paired change" value={pts(st.verdict.failure.delta)}
                    sub={`95% CI [${pts(st.verdict.failure.ciLow)}, ${pts(st.verdict.failure.ciHigh)}]`}
                    tone={st.verdict.failure.ciHigh < 0 ? 'good' : st.verdict.failure.ciLow > 0 ? 'bad' : 'warn'} />
                  <Figure label="net annual" value={eur(st.verdict.netEur)} tone={st.verdict.netEur > 0 ? 'good' : 'bad'}
                    sub="after the cost of the controls themselves" />
                  <Figure label="combined exposure" value={eur(st.summary.annualLossEur)}
                    sub={`CVaR ${eur(st.summary.cvarCostEur)} per bad shift`} />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="label">controls that survived</span>
                  {st.controls.length ? st.controls.map((id) => {
                    const c = catalogue.find((x) => x.id === id);
                    return (
                      <span key={id} className="border border-phosphor/40 bg-phosphor/10 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-phosphor">
                        {c ? c.label : id}
                      </span>
                    );
                  }) : <span className="text-[11px] text-ash">none</span>}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => { setPendingControls([...st.controls]); s.setCfg({ controls: [...st.controls] }); }}
                    disabled={s.running}
                    className="border border-phosphor/60 bg-phosphor/12 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-phosphor enabled:hover:bg-phosphor/20 disabled:opacity-40">
                    load this variant and re-fuzz
                  </button>
                  <span className="text-[11px] text-ash">
                    sets the header controls to {st.controls.join(', ') || 'nothing'} and runs the line map on the revised procedure
                  </span>
                </div>

                {!st.verdict.accepted && (
                  <p className="mt-3 border border-vermillion/40 bg-vermillion/8 px-3 py-2 text-[11px] text-vermillion">
                    The stacked set as a whole was not accepted: {st.verdict.reasons.join('; ')}
                  </p>
                )}
              </>
            );
          })()
        ) : (
          <p className="mt-2 text-[11px] text-ash">
            {s.repair.running ? 'Stacking happens after every candidate has been tested.' : 'No survivor to stack yet. A loop that finds nothing is a real result: it means this procedure does not have a cheap fix.'}
          </p>
        )}
      </section>

      {/* --------------------------------------------------------- change order */}
      <ChangeOrder s={s} />
    </div>
  );
}

function ControlCard({ c, procedure, on, strong, disabled, onToggle }: {
  c: Intervention;
  procedure: ReturnType<typeof procedureById>;
  on: boolean;
  strong: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const targets = useMemo(() => targetSteps(c, procedure).map((t) => t.id), [c, procedure]);
  const appliesToSomething = targets.length > 0 || c.effect.plant !== undefined || c.effect.startLevelFrac !== undefined;

  return (
    <button type="button" onClick={onToggle} disabled={disabled}
      aria-pressed={on}
      className={`flex flex-col gap-1.5 p-3 text-left transition-opacity disabled:opacity-50 ${
        strong
          ? `border border-rule ${on ? 'border-l-[4px] border-l-phosphor bg-phosphor/8' : 'border-l-[4px] border-l-rule'} bg-graphite`
          : `border border-dashed ${on ? 'border-amber bg-amber/8' : 'border-rule'} bg-graphite`
      }`}>
      <span className="flex w-full items-baseline gap-2">
        <span className={`readout text-[11px] uppercase tracking-[0.12em] ${on ? 'text-phosphor' : 'text-ash'}`}>{c.id}</span>
        <span className="label ml-auto">{on ? 'applied' : 'not applied'}</span>
      </span>
      <span className="text-[12px] leading-snug text-bone">{c.label}</span>
      <span className="text-[11px] leading-relaxed text-ash">{c.describe}</span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-ash">
        <span>{eur(c.effect.annualCostEur ?? 0)}/yr</span>
        <span>{c.effect.addedSeconds ?? 0} s added</span>
        <span className={appliesToSomething ? 'text-cyan' : 'text-vermillion'}>
          {targets.length ? `acts on ${targets.join(', ')}` : 'no step in this procedure admits it'}
        </span>
      </span>
    </button>
  );
}

function TrialCard({ t, onStep }: { t: CandidateTrial; onStep: (id: string) => void }) {
  const v = t.verdict;
  const accepted = v?.accepted === true;
  const base = v?.failure.baseMean ?? 0;
  const cand = v?.failure.candMean ?? 0;

  return (
    <article className={`border ${accepted ? 'border-phosphor/50' : 'border-vermillion/40'} bg-graphite p-3`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="readout text-[11px] uppercase tracking-[0.14em] text-ash">{t.control.id}</span>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ash">{t.control.tier}</span>
        <span className={`ml-auto text-[15px] uppercase tracking-[0.18em] ${
          v === undefined ? 'text-ash' : accepted ? 'text-phosphor' : 'text-vermillion'}`}>
          {v === undefined ? 'NOT TESTED' : accepted ? 'ACCEPTED' : 'REJECTED'}
        </span>
      </div>

      <p className="mt-1 text-[12px] leading-snug text-bone">{t.control.label}</p>

      {t.error && (
        <p className="mt-2 border-l-2 border-ash pl-2 text-[11px] text-ash">{t.error}</p>
      )}

      {v && (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[11px]">
            <span className="flex items-baseline gap-1.5">
              <span className="label">baseline</span>
              <span className="readout text-[14px] text-bone">{pct(base)}</span>
            </span>
            <span className="flex items-baseline gap-1.5">
              <span className="label">with control</span>
              <span className={`readout text-[14px] ${cand < base ? 'text-phosphor' : cand > base ? 'text-vermillion' : 'text-bone'}`}>{pct(cand)}</span>
            </span>
            <span className="ml-auto flex items-baseline gap-1.5">
              <span className="label">paired change</span>
              <span className={`readout text-[14px] ${v.failure.delta < 0 ? 'text-phosphor' : 'text-vermillion'}`}>{pts(v.failure.delta)}</span>
            </span>
          </div>

          <DeltaBar low={v.failure.ciLow} high={v.failure.ciHigh} delta={v.failure.delta} />

          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
            <span className="text-ash">
              one-sided bootstrap risk <span className="readout text-bone">{(v.failure.oneSidedRisk * 100).toFixed(1)}%</span>
            </span>
            <span className="text-ash">
              loss avoided <span className="readout text-bone">{eur(v.annualGainEur)}/yr</span>
            </span>
            <span className="text-ash">
              control cost <span className="readout text-bone">{eur(t.control.annualCostEur)}/yr</span>
            </span>
            <span className="text-ash">
              net <span className={`readout ${v.netEur > 0 ? 'text-phosphor' : 'text-vermillion'}`}>{eur(v.netEur)}/yr</span>
            </span>
          </div>
          <p className="mt-1 text-[10px] text-ash">
            net is the annual loss avoided less the annual cost of this control, as computed by the gate;
            the control cost is not deducted twice.
          </p>

          {t.targets.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="label">attached to</span>
              {t.targets.map((id) => (
                <button key={id} onClick={() => onStep(id)}
                  className="border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-cyan hover:border-cyan">
                  {id}
                </button>
              ))}
            </div>
          )}

          <div className="mt-3">
            <span className="label">{accepted ? 'why it was kept' : 'why it was thrown out'}</span>
            <ul className={`mt-1 border-l-2 pl-3 ${accepted ? 'border-phosphor' : 'border-vermillion'}`}>
              {v.reasons.length ? v.reasons.map((r, i) => (
                <li key={`${t.control.id}-r-${i}`} className={`text-[11px] leading-relaxed ${accepted ? 'text-phosphor' : 'text-vermillion'}`}>
                  {r}
                </li>
              )) : (
                <li className="text-[11px] text-phosphor">every gate condition met: paired fall in failure rate, thinner tail, net above threshold</li>
              )}
            </ul>
          </div>
        </>
      )}
    </article>
  );
}

/** The confidence band belongs to the difference, not to either arm. */
function DeltaBar({ low, high, delta }: { low: number; high: number; delta: number }) {
  const pad = Math.max(Math.abs(high - low) * 0.25, 1e-4);
  const lo = Math.min(low, 0) - pad;
  const hi = Math.max(high, 0) + pad;
  const at = (v: number) => `${((v - lo) / Math.max(1e-12, hi - lo)) * 100}%`;
  const excludesZero = low > 0 || high < 0;
  return (
    <div className="mt-3">
      <div className="relative h-[20px] border border-rule bg-void">
        <div className="absolute inset-y-0 w-[1px] bg-ash" style={{ left: at(0) }} title="no change" />
        <div className="absolute top-1/2 h-[1px] bg-cyan" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
        <div className="absolute top-1/2 h-[12px] w-[1px] bg-cyan" style={{ left: at(low) }} />
        <div className="absolute top-1/2 h-[12px] w-[1px] bg-cyan" style={{ left: at(high) }} />
        <div className="absolute top-1/2 h-[16px] w-[3px] -translate-y-1/2 bg-bone" style={{ left: at(delta) }} />
      </div>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-ash">
        95% CI of the paired difference {low >= 0 ? '+' : ''}{(low * 100).toFixed(3)} to {high >= 0 ? '+' : ''}{(high * 100).toFixed(3)} points -{' '}
        <span className={excludesZero ? 'text-phosphor' : 'text-amber'}>
          {excludesZero ? 'excludes no change' : 'includes no change'}
        </span>
      </p>
    </div>
  );
}

function Figure({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' }) {
  const colour = tone === 'good' ? 'text-phosphor' : tone === 'bad' ? 'text-vermillion' : tone === 'warn' ? 'text-amber' : 'text-bone';
  return (
    <div className="flex flex-col leading-tight">
      <span className="label">{label}</span>
      <span className={`readout text-[17px] ${colour}`}>{value}</span>
      {sub && <span className="text-[10px] text-ash">{sub}</span>}
    </div>
  );
}

function phaseColour(phase: string): string {
  if (phase === 'error') return 'text-vermillion';
  if (phase === 'stack' || phase === 'done') return 'text-phosphor';
  if (phase === 'skip') return 'text-ash';
  if (phase === 'baseline') return 'text-cyan';
  return 'text-amber';
}

/**
 * The document a plant actually acts on. Assembled only from store state:
 * baseline, survivors, the paired interval, the cost line, and the signature
 * block that says a machine did not authorise this.
 */
function ChangeOrder({ s }: { s: ConsoleStore }) {
  const st = s.repair.stacked;
  const baseline: SummaryDto | null = s.repair.baseline ?? s.summary;
  const accepted = s.repair.trials.filter((t) => t.verdict?.accepted);
  const rejected = s.repair.trials.filter((t) => t.verdict && !t.verdict.accepted);

  if (!st || !baseline) {
    return (
      <section className="panel p-4">
        <h3 className="text-[12px] uppercase tracking-[0.18em] text-bone">Change order</h3>
        <p className="mt-2 max-w-[900px] text-[11px] leading-relaxed text-ash">
          No order can be written yet: the loop has produced no stacked, tested variant. When it does, this
          block becomes a printable one-page change order carrying the baseline, the survivors, the paired
          interval, the cost line and the reasons everything else was thrown out. Nothing is entered here that
          was not computed above.
        </p>
      </section>
    );
  }

  const generated = new Date().toISOString();
  const controls = st.controls
    .map((id) => s.repair.trials.find((t) => t.control.id === id))
    .filter((t): t is CandidateTrial => t !== undefined);
  const cost = controls.reduce((a, b) => a + (b?.control.annualCostEur ?? 0), 0);

  return (
    <section className="print-sheet panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h3 className="text-[13px] uppercase tracking-[0.2em] text-amber">Change order</h3>
        <span className="readout text-[11px] text-ash">{st.summary.variantId}</span>
        <span className="ml-auto text-[11px] text-ash">generated {generated}</span>
        <button onClick={() => window.print()} className="no-print border border-amber bg-amber/12 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-amber hover:bg-amber/25">
          print this sheet
        </button>
      </div>

      <ol className="mt-4 space-y-2 text-[12px] leading-relaxed text-bone">
        <li><span className="label">1 procedure under change</span><br />
          {s.run_config.procedure.id} rev {s.run_config.procedure.revision} - {s.run_config.procedure.title}</li>
        <li><span className="label">2 configuration tested</span><br />
          crew {s.run_config.persona.label}; plant state {s.run_config.plant.label}; method {s.cfg.method.toUpperCase()};
          seed {s.cfg.seed}; baseline {baseline.failed} of {baseline.n.toLocaleString('en-US')} shifts failing ({pct(baseline.failureRate)})</li>
        <li><span className="label">3 changes adopted</span>
          <ul className="mt-1 space-y-1">
            {controls.map((t) => t && (
              <li key={`co-${t.control.id}`} className="border-l-2 border-phosphor pl-3">
                <span className="text-bone">{t.control.label}</span>
                <span className="text-ash"> - {t.control.tier}, acts on {t.targets.join(', ') || 'the configuration'}, {eur(t.control.annualCostEur)}/yr, {eur(t.verdict?.netEur ?? 0)}/yr net</span>
              </li>
            ))}
          </ul>
        </li>
        <li><span className="label">4 measured effect of the set as a whole</span><br />
          failure {pct(baseline.failureRate)} to {pct(st.summary.failureRate)}, paired change{' '}
          {pts(st.verdict.failure.delta)} with 95% CI [{pts(st.verdict.failure.ciLow)}, {pts(st.verdict.failure.ciHigh)}];
          expected loss {eur(baseline.annualLossEur)}/yr to {eur(st.summary.annualLossEur)}/yr; controls cost{' '}
          {eur(cost)}/yr; net {eur(st.verdict.netEur)}/yr.
          <span className="text-ash"> {accepted.length} candidate{accepted.length === 1 ? '' : 's'} passed the individual gate;{' '}
          {st.controls.length} of them are in the adopted set, because controls are re-tested together before
          anything is claimed.</span></li>
        <li><span className="label">5 ideas tested and rejected</span><br />
          <span className="text-ash">{rejected.length ? rejected.map((t) => `${t.control.id} (${t.verdict?.reasons[0] ?? 'no reason recorded'})`).join('; ') : 'none - every candidate the procedure admitted was adopted'}</span></li>
        <li><span className="label">6 what this does not say</span><br />
          <span className="text-ash">The base rates are order-of-magnitude screening values and the process model is an engineered surrogate. This ranks and sizes a change; it does not forecast an incident. MURPHY is a prioritisation instrument, not a probability forecast.</span></li>
      </ol>

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        {['prepared by (analyst)', 'reviewed by (process safety)', 'authorised by (asset owner)'].map((r) => (
          <div key={r}>
            <div className="h-[34px] border-b border-ash/60" />
            <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ash">{r}</div>
            <div className="mt-3 h-[16px] border-b border-rule" />
            <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-ash">date</div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] leading-relaxed text-ash">
        No change on this sheet takes effect until all three signatures are on paper. The simulation is the
        evidence, not the approval.
      </p>
    </section>
  );
}
