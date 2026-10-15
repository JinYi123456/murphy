'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { getTwin } from '../engine/twins/index';
import { computeHep, HEART_GTT, PROTECTION_FOD, SPAR_NOMINAL, SPAR_PSFs, THERP_BASE } from '../engine/hra';
import type { HepResult, HraMethod, PsfState } from '../engine/hra';
import { CONDITION_LABELS, levelLabel, levelMult } from '../engine/conditions';
import type { ConditionId } from '../engine/conditions';
import { assess } from '../engine/assess';
import { conditionsFor, sampleSetup } from '../engine/runner';
import { seedToKey } from '../engine/prng';
import type { StepAudit } from '../engine/runner';
import type { RunConfig, Step } from '../engine/types';
import type { Patch } from '../engine/types';
import type { StepStatDto } from '../lib/dto';

const pct = (v: number, dp = 2) => `${(v * 100).toFixed(dp)}%`;
const sci = (v: number) => v.toExponential(1);

const METHOD_LABEL: Record<HraMethod, string> = { sparh: 'SPAR-H', therp: 'THERP', heart: 'HEART' };
const METHODS: HraMethod[] = ['sparh', 'therp', 'heart'];

interface Worksheet {
  audit: StepAudit;
  /** the shaping rows the worksheet was built from, kept so the same step can be re-scored by another method */
  psfs: PsfState[];
  scenario: number;
  alarmRinging: boolean;
}

/**
 * Read-only derivation for one step, calling the same three engine functions
 * the runner calls, in the same order.
 *
 * When a recorded shift is loaded its audit trail is shown verbatim - it
 * contains the conditions only a running shift can earn, a slipped schedule and
 * an alarm ringing during the action. When nothing is loaded this path produces
 * the worksheet on demand, on plan and silent, and the screen says so instead of
 * pretending it came from a real shift.
 */
function deriveWorksheet(run: RunConfig, step: Step, method: HraMethod, scenario: number, alarmRinging: boolean): Worksheet {
  const setup = sampleSetup(run, seedToKey(run.seed), scenario);
  const conds = conditionsFor(
    step, run.persona, run.plant,
    { slipRatio: 1, alarmRinging, hazardSeen: false, setup },
    (run.procedure.warnings ?? []).map((w) => ({ cond: w.cond, level: w.level, steps: w.steps })),
  );
  const assessment = assess({ step, persona: run.persona, plant: run.plant, alarmRinging }, conds);
  const hep = computeHep({
    method,
    kind: step.kind,
    similarity: step.similarity,
    insideProcedure: step.applies !== undefined || step.verify !== undefined,
    psfs: assessment.rows,
    gtt: step.gtt,
  });
  return {
    scenario,
    alarmRinging,
    psfs: assessment.rows,
    audit: {
      stepId: step.id, p: hep.p, lo: hep.lo, hi: hep.hi, nominal: hep.nominal, multiplier: hep.multiplier,
      kind: step.kind, basis: hep.basis, adjusted: hep.adjusted,
      rows: hep.rows.map((r, i) => ({ ...r, why: assessment.rows[i]?.why ?? '' })),
      suppressed: assessment.suppressed.map((x) => ({ psf: x.psf, level: x.why, why: x.why })),
      conditions: Object.keys(conds) as ConditionId[],
    },
  };
}

/**
 * The wire type declares a patch as `{ set: {...} }`; the procedure data in
 * data/procedures writes its assignments straight onto the patch object. Both
 * shapes are read, because the JSON is the source of truth about what an error
 * does to the plant and the inspector must not show an empty patch for an error
 * that plainly carries one. The cast is at that data boundary.
 */
function patchAssignments(patch: Patch | undefined): Record<string, number> {
  const raw = (patch ?? {}) as Record<string, unknown>;
  const nested = raw.set;
  if (nested && typeof nested === 'object') return nested as Record<string, number>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') out[k] = v;
  return out;
}

export function StepInspector({ s }: { s: ConsoleStore }) {
  const stepId = s.selectedStep;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [showLevels, setShowLevels] = useState(false);

  const close = useCallback(() => s.setSelectedStep(null), [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const f = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? []);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const step = stepId ? s.run_config.procedure.steps.find((x) => x.id === stepId) ?? null : null;
  const twin = getTwin(s.run_config.procedure.twin);
  const stat: StepStatDto | undefined = stepId ? s.summary?.perStep[stepId] : undefined;
  const method = s.cfg.method;

  const recorded = s.activeShift?.audit.find((a) => a.stepId === stepId) ?? null;
  const onPlan = useMemo(
    () => (step ? deriveWorksheet(s.run_config, step, method, 0, false) : null),
    [step, s.run_config, method],
  );
  const sheet = recorded ? { scenario: s.activeShift?.scn ?? 0, psfs: onPlan?.psfs ?? [], alarmRinging: true } : onPlan;
  const audit: StepAudit | null = recorded ?? onPlan?.audit ?? null;

  /** the identical shaping worksheet put through the other two published methods */
  const allMethods = useMemo(() => {
    if (!step || !sheet?.psfs.length) return [] as { method: HraMethod; hep: HepResult }[];
    return METHODS.map((m) => ({
      method: m,
      hep: computeHep({
        method: m,
        kind: step.kind,
        similarity: step.similarity,
        insideProcedure: step.applies !== undefined || step.verify !== undefined,
        psfs: sheet.psfs,
        gtt: step.gtt,
      }),
    }));
  }, [step, sheet]);

  const replayable = stepId ? s.traced.filter((t) => t.errors.some((e) => e.stepId === stepId)) : [];
  const weightTotal = step?.errors?.reduce((a, b) => a + b.weight, 0) ?? 0;

  return (
    <>
      <div className="no-print fixed inset-0 z-40 bg-void/78" onClick={close} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="step-inspector-title"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[640px] flex-col overflow-y-auto border-l border-rule bg-graphite outline-none">
        {!step ? (
          <div className="p-5">
            <p className="text-[12px] leading-relaxed text-ash">
              This step is not in the procedure under test - it probably belongs to a revision that the
              controls on the header bar have since rewritten or removed.
            </p>
            <button onClick={close}
              className="mt-3 border border-rule px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-bone hover:border-amber hover:text-amber">
              close
            </button>
          </div>
        ) : (
          <>
            <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-rule bg-panel px-4 py-3">
              <div className="min-w-0">
                <span className="label">step {step.id}</span>
                <h2 id="step-inspector-title" className="mt-0.5 text-[13px] uppercase tracking-[0.18em] text-amber">
                  {step.title}
                </h2>
              </div>
              <button onClick={close} aria-label="Close step inspector"
                className="no-print ml-auto shrink-0 border border-rule px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-ash hover:border-vermillion hover:text-vermillion">
                close
              </button>
            </header>

            <div className="space-y-5 px-4 py-4">
              {/* ---------------------------------------------------- verbatim text */}
              <section>
                <span className="label">
                  as written, {s.run_config.procedure.id} rev {s.run_config.procedure.revision}
                </span>
                <p className="sop-text mt-1 border-l-2 border-amber pl-3">{step.text}</p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[11px]">
                  <Meta label="role" value={step.role} />
                  <Meta label="cue the operator relies on" value={step.cue} />
                  <Meta label="action kind" value={step.kind} />
                  <Meta label="nominal duration" value={`${step.durS} s`} />
                  {step.gtt && <Meta label="heart task type" value={`${step.gtt} - ${HEART_GTT[step.gtt]?.label ?? 'unlisted'}`} />}
                  {step.similarity !== undefined && <Meta label="confusable devices" value={String(step.similarity)} />}
                  {step.xcheck && <Meta label="a control requires" value="an independent second-person check" />}
                  {step.verify && <Meta label="this step checks" value={step.verify.of.join(', ')} />}
                  {step.watch && <Meta label="this step watches" value={`${step.watch.var} at ${step.watch.atLeast ?? step.watch.atMost ?? '-'}`} />}
                </div>
                {step.cond && step.cond.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    <span className="label mr-2">annotated conditions</span>
                    {step.cond.map((c) => (
                      <span key={c} title={`condition ${c}`}
                        className="border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-amber">
                        {CONDITION_LABELS[c] ?? c}
                      </span>
                    ))}
                  </div>
                )}
              </section>

              {/* ---------------------------------------------------- what happened */}
              {stat ? (
                <section className="border border-rule bg-panel p-3">
                  <span className="label">counted in the batch that ran</span>
                  <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4">
                    <Meta label="reached" value={stat.reached.toLocaleString('en-US')} />
                    <Meta label="thrown" value={stat.thrown.toLocaleString('en-US')} tone={stat.thrown ? 'warn' : 'neutral'} />
                    <Meta label="caught later" value={stat.caught.toLocaleString('en-US')} tone="good" />
                    <Meta label="escaped" value={stat.escaped.toLocaleString('en-US')} tone={stat.escaped ? 'bad' : 'neutral'} />
                    <Meta label="first causal" value={stat.causal.toLocaleString('en-US')} />
                    <Meta label="causal on a failed shift" value={stat.causalFailure.toLocaleString('en-US')} tone={stat.causalFailure ? 'bad' : 'neutral'} />
                    <Meta label="share of survivors" value={pct(stat.escapeShare, 1)} />
                    <Meta label="mean modelled p" value={sci(stat.p)} />
                  </div>
                  <div className="relative mt-3 h-[8px] bg-void" title={`escape share ${pct(stat.escapeShare, 1)}`}>
                    <div className="absolute inset-y-0 left-0 bg-vermillion" style={{ width: `${Math.min(100, stat.escapeShare * 100)}%`, opacity: 0.85 }} />
                    <div className="absolute inset-y-0 left-0 bg-phosphor"
                      style={{
                        width: `${Math.min(100, (stat.thrown ? (stat.caught / stat.thrown) * 100 : 0))}%`,
                        opacity: 0.35,
                      }} title="of everything thrown here, the share a later step caught" />
                  </div>
                </section>
              ) : (
                <p className="border border-rule bg-panel px-3 py-2 text-[11px] leading-relaxed text-ash">
                  No batch has counted this step yet, so there is nothing to report about what happened here.
                  The derivation below is the model speaking, not the batch.
                </p>
              )}

              {/* ---------------------------------------------------- error surface */}
              <section>
                <div className="flex flex-wrap items-baseline gap-x-4">
                  <span className="label">active error surface</span>
                  <p className="text-[11px] text-ash">one of these is drawn in proportion to its weight whenever this step fails</p>
                </div>
                {!step.errors?.length ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-ash">
                    This step carries no modelled error surface: the procedure gives it no way to go wrong in
                    this revision, so any risk at this station arrives from the plant state or another step.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {step.errors.map((e) => {
                      const keys = Object.entries(patchAssignments(e.patch));
                      const share = weightTotal > 0 ? e.weight / weightTotal : 0;
                      return (
                        <li key={e.id} className="border-l-2 border-vermillion/70 bg-panel px-3 py-2">
                          <div className="flex flex-wrap items-baseline gap-x-3">
                            <span className="readout text-[11px] text-bone">{e.id}</span>
                            <span className="text-[10px] uppercase tracking-[0.14em] text-vermillion">{e.kind}</span>
                            <SourceBadge source={e.source} />
                            <span className="ml-auto readout text-[11px] text-ash">
                              weight {e.weight} - {pct(share, 1)} of the failures here
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-bone">{e.text}</p>
                          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[0.1em]">
                            {keys.length === 0 && <span className="text-ash">no plant assignment - a pure omission</span>}
                            {keys.map(([k, v]) => {
                              const isDisc = twin.discIndex(k) >= 0;
                              const isVar = twin.varIndex(k) >= 0;
                              const what = isDisc ? 'scenario state' : isVar ? 'process variable' : 'not on this twin';
                              return (
                                <span key={`${e.id}-${k}`} className={isDisc || isVar ? 'text-cyan' : 'text-vermillion'}
                                  title={`${twin.id}: ${k}`}>
                                  {what} {k} {'->'} {v}
                                </span>
                              );
                            })}
                            {e.alsoApplies && <span className="text-amber">intended action still performed</span>}
                            {e.symptom && <span className="text-phosphor">what they would notice: {e.symptom}</span>}
                          </div>
                          <div className="relative mt-2 h-[6px] bg-void">
                            <div className="absolute inset-y-0 left-0 bg-vermillion/70" style={{ width: `${share * 100}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* ---------------------------------------------------- HRA worksheet */}
              <section>
                <div className="flex flex-wrap items-baseline gap-x-4">
                  <span className="label">hra worksheet, {METHOD_LABEL[method]}</span>
                  {audit && (
                    <span className={`text-[10px] uppercase tracking-[0.12em] ${recorded ? 'text-phosphor' : 'text-amber'}`}>
                      {recorded
                        ? `recorded in scenario #${s.activeShift?.scn} of this shift`
                        : `derived here for scenario #${onPlan?.scenario ?? 0} - on plan, no alarm ringing`}
                    </span>
                  )}
                </div>

                {audit ? (
                  <>
                    <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-3">
                      <Meta label="human error probability" value={sci(audit.p)} big tone="warn" />
                      <Meta label="nominal first estimate" value={sci(audit.nominal)} />
                      <Meta label="shaping product" value={`${audit.multiplier.toFixed(2)}x`} />
                      <Meta label="crew" value={s.run_config.persona.label} />
                      <Meta label="plant state" value={s.run_config.plant.label} />
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed text-ash">{audit.basis}</p>

                    <table className="mt-3 w-full text-[11px]">
                      <thead>
                        <tr className="text-left uppercase tracking-[0.12em] text-ash">
                          <th className="pr-2 font-normal">psf</th>
                          <th className="pr-2 font-normal">factor</th>
                          <th className="pr-2 font-normal">level</th>
                          <th className="pr-2 text-right font-normal">mult</th>
                          <th className="font-normal">why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {audit.rows.map((r, i) => (
                          <tr key={`${r.id}-${i}`} className={`border-t border-rule ${r.mult > 1 ? '' : 'opacity-70'}`}>
                            <td className="py-1 pr-2 readout text-bone">{r.id}</td>
                            <td className="py-1 pr-2 text-ash">{r.label}</td>
                            <td className="py-1 pr-2 text-bone">{r.level}</td>
                            <td className={`py-1 pr-2 text-right readout ${r.mult > 1 ? 'text-vermillion' : r.mult < 1 ? 'text-phosphor' : 'text-ash'}`}>
                              {r.mult.toFixed(2)}
                            </td>
                            <td className="py-1 text-[10px] leading-snug text-ash">{r.why}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {audit.conditions.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1">
                        <span className="label mr-2">conditions acting on this performance</span>
                        {audit.conditions.map((c) => (
                          <span key={`ac-${c}`} className="border border-rule px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-cyan">
                            {CONDITION_LABELS[c as ConditionId] ?? c}
                          </span>
                        ))}
                      </div>
                    )}

                    {audit.suppressed.length > 0 && (
                      <div className="mt-3 border border-amber/40 bg-amber/8 px-3 py-2">
                        <span className="label">present but held at nominal</span>
                        <ul className="mt-1 space-y-1">
                          {audit.suppressed.map((x, i) => (
                            <li key={`sup-${i}`} className="text-[11px] leading-relaxed text-amber">{x.psf}: {x.why}</li>
                          ))}
                        </ul>
                        <p className="mt-1 text-[10px] leading-relaxed text-ash">
                          SPAR-H factors are not independent: rushed, fatigued and a poor procedure are often
                          one situation described three times, so at most three negative factors are allowed to
                          act on a single step. The count is held, not deleted, so a reviewer can overrule it.
                        </p>
                      </div>
                    )}

                    <button onClick={() => setShowLevels((v) => !v)}
                      className="no-print mt-3 border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-ash hover:border-amber hover:text-amber">
                      {showLevels ? 'hide the published level table' : 'show the published level table'}
                    </button>
                    {showLevels && (
                      <div className="mt-2 space-y-2 border border-rule bg-panel p-3">
                        {audit.rows.map((r, i) => {
                          const id = r.id as PsfState['psf'];
                          const def = SPAR_PSFs[id];
                          if (!def) return null;
                          const chosen = def.levels.findIndex((l) => l.name === r.level);
                          return (
                            <div key={`lv-${i}`}>
                              <span className="readout text-[10px] uppercase tracking-[0.12em] text-bone">{id} - {def.label}</span>
                              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                                {def.levels.map((l, li) => (
                                  <span key={`${id}-${li}`} className={`text-[10px] ${li === chosen ? 'text-vermillion' : 'text-ash'}`}>
                                    {levelLabel(id, li)} x{levelMult(id, li)}{l.fails ? ' (unachievable)' : ''}{li === chosen ? ' used' : ''}
                                  </span>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                        <p className="mt-1 text-[10px] leading-relaxed text-ash">
                          All eight published factors are scored for every action, not only the ones something
                          bad triggered. Nominals on offer: SPAR-H action {sci(SPAR_NOMINAL.action)} / diagnosis{' '}
                          {sci(SPAR_NOMINAL.diagnosis)}; THERP general first estimate {sci(THERP_BASE.general_first_estimate.p)};
                          HEART generic task types from {sci(Math.min(...Object.values(HEART_GTT).map((g) => g.gep)))} to{' '}
                          {sci(Math.max(...Object.values(HEART_GTT).map((g) => g.gep)))}. Under HEART the rows above are
                          rescaled by the assumed probabilistic impact of each condition, which is why the level
                          names change and the highlighting stops.
                        </p>
                      </div>
                    )}

                    <div className="mt-4">
                      <span className="label">the same shaping worksheet through all three methods</span>
                      {recorded && (
                        <p className="mt-1 text-[10px] leading-relaxed text-amber">
                          the recorded audit stores which conditions acted on this performance but not their
                          severity, so this re-scoring runs on the derived worksheet above rather than on the
                          shift's own rows.
                        </p>
                      )}
                      <div className="mt-2 space-y-1.5">
                        {allMethods.map(({ method: m, hep }) => (
                          <div key={`am-${m}`} className="flex items-center gap-3">
                            <span className={`w-[64px] shrink-0 text-[11px] uppercase tracking-[0.12em] ${m === method ? 'text-amber' : 'text-ash'}`}>
                              {METHOD_LABEL[m]}
                            </span>
                            <div className="relative h-[12px] flex-1 bg-void">
                              <div className="absolute inset-y-0 left-0 bg-cyan"
                                style={{ width: `${logPos(hep.p) * 100}%`, opacity: m === method ? 0.85 : 0.45 }} />
                            </div>
                            <span className="readout w-[190px] shrink-0 text-right text-[11px] text-bone">
                              {sci(hep.p)} <span className="text-ash">[{sci(hep.lo)}, {sci(hep.hi)}]</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* --------------------------------------------------- the band */}
                    <div className="mt-4 border border-rule bg-panel p-3">
                      <span className="label">order-of-magnitude band</span>
                      <div className="relative mt-3 h-[22px] bg-void">
                        {[1e-5, 1e-4, 1e-3, 1e-2, 1e-1].map((g) => (
                          <span key={`g-${g}`} className="absolute top-0 h-full w-[1px] bg-rule" style={{ left: `${logPos(g) * 100}%` }} />
                        ))}
                        <div className="absolute inset-y-[6px] bg-violet/45"
                          style={{ left: `${logPos(audit.lo) * 100}%`, width: `${Math.max(1, (logPos(audit.hi) - logPos(audit.lo)) * 100)}%` }} />
                        <div className="absolute inset-y-0 w-[2px] bg-bone" style={{ left: `${logPos(audit.p) * 100}%` }} />
                      </div>
                      <div className="mt-1 flex justify-between text-[10px] readout text-ash">
                        <span>{sci(audit.lo)}</span>
                        <span className="text-bone">point {sci(audit.p)}</span>
                        <span>{sci(audit.hi)}</span>
                      </div>
                      <p className="mt-2 text-[11px] leading-relaxed text-ash">
                        The source guidance states its own base rates as accurate to within an order of
                        magnitude, and the shaping judgement moves them again, so the honest output for one step
                        is a band. The point inside it is only worth anything because the same band applies to
                        every step in the sequence and the ranking is what survives the width.
                      </p>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-[11px] leading-relaxed text-ash">
                    No worksheet: this step cannot be scored without a run configuration.
                  </p>
                )}
              </section>

              {/* ---------------------------------------------- protection basis */}
              <section className="border border-rule bg-panel p-3">
                <span className="label">fail-on-demand assumed of the protective functions</span>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                  <Meta label="soft alarm on a shared measurement" value={sci(PROTECTION_FOD.soft_alarm)} />
                  <Meta label="independent switch" value={sci(PROTECTION_FOD.independent_switch)} />
                  <Meta label="independent switch, proved in interval" value={sci(PROTECTION_FOD.independent_switch_proven)} />
                  <Meta label="interlock" value={sci(PROTECTION_FOD.interlock)} />
                  <Meta label="operator response" value={sci(PROTECTION_FOD.operator_response)} />
                  <Meta label="containment" value={sci(PROTECTION_FOD.containment)} />
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-ash">
                  {s.run_config.plant.provenRecent
                    ? 'The plant state in this run has the protective device proved inside its test interval, so the design rate applies.'
                    : 'The plant state in this run has no current proof test, so the unproved rate applies to the same hardware. That difference is a condition, not an opinion.'}
                </p>
              </section>

              {/* ---------------------------------------------------------- replay */}
              <section className="no-print border border-rule bg-panel p-3">
                <span className="label">watch it happen</span>
                {replayable.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {replayable.map((t) => (
                      <button key={`rp-${t.scn}`} onClick={() => void s.loadReplay(t.scn)}
                        className="border border-vermillion/50 bg-vermillion/8 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.14em] text-vermillion hover:bg-vermillion/16">
                        replay #{t.scn}, {t.outcome}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <p className="text-[11px] text-ash">
                      None of the {s.traced.length} shifts the batch kept for replay broke at {step.id}.
                    </p>
                    {s.traced.length > 0 && (
                      <button onClick={() => void s.loadReplay(s.traced[0].scn)}
                        className="border border-rule px-2.5 py-1.5 text-[10px] uppercase tracking-[0.14em] text-ash hover:border-amber hover:text-amber">
                        replay the most expensive recorded shift anyway
                      </button>
                    )}
                  </div>
                )}
                <p className="mt-2 text-[10px] leading-relaxed text-ash">
                  A recording is recomputed from the seed and the scenario index rather than stored, so the tape
                  is identical in any batch size and on any machine running the same kernel.
                </p>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function logPos(p: number): number {
  const lo = Math.log10(1e-6);
  const hi = Math.log10(1);
  const t = (Math.log10(Math.max(1e-6, Math.min(1, p))) - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t));
}

function Meta({ label, value, big, tone = 'neutral' }: {
  label: string; value: string; big?: boolean; tone?: 'good' | 'bad' | 'warn' | 'neutral';
}) {
  const colour = tone === 'bad' ? 'text-vermillion' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <span className="flex flex-col leading-tight">
      <span className="label">{label}</span>
      <span className={`readout ${big ? 'text-[20px]' : 'text-[12px]'} ${colour}`}>{value}</span>
    </span>
  );
}

function SourceBadge({ source }: { source: 'analyst' | 'model' | 'model+review' }) {
  const tone = source === 'analyst'
    ? 'border-cyan/50 text-cyan'
    : source === 'model+review'
      ? 'border-violet/50 text-violet'
      : 'border-amber/50 text-amber';
  const title = source === 'analyst'
    ? 'written by the analyst from the procedure text and the incident record'
    : source === 'model+review'
      ? 'drafted by a language model, then checked line by line against the source document'
      : 'drafted by a language model and not reviewed by a person - treat it as a hypothesis, not evidence';
  return (
    <span title={title} className={`border px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] ${tone}`}>
      {source}
    </span>
  );
}
