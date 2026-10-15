import Link from 'next/link';
import { PERSONAS, PLANTS, procedureById } from '../../lib/registry';
import { CONDITION_LABELS, PSF_REFERENCE } from '../../engine/conditions';
import type { ConditionId } from '../../engine/conditions';
import { assess, MAX_NEGATIVE_PSFS } from '../../engine/assess';
import { conditionsFor } from '../../engine/runner';
import type { ScenarioSetup } from '../../engine/runner';
import {
  APOA_BY_LEVEL, HEART_EPC_MAX, HEART_GTT, HRA_METHODS, SPAR_FLOOR, SPAR_NOMINAL,
  THERP_BASE, THERP_ERROR_FACTOR, computeHep,
} from '../../engine/hra';
import type { HepResult, HraMethod } from '../../engine/hra';
import { interventionById } from '../../engine/repair';
import type { Step } from '../../engine/types';
import { getTwin } from '../../engine/twins/index';

export const metadata = {
  title: 'Method - MURPHY',
  description: 'Where every probability on this screen comes from, and what it does not mean.',
};

const STEP_ID = 'd8';
const PERSONA_ID = 'daytime_competent';
const PLANT_ID = 'tk_after_instrument_work';

const setup: ScenarioSetup = {
  permitLeftSomethingIsolated: false,
  instrumentDrift: 0,
  driveDegraded: 1,
  protectionFailedOnDemand: false,
};

const METHOD_META: Record<HraMethod, { name: string; source: string; rule: string }> = {
  sparh: {
    name: 'SPAR-H',
    source: 'NUREG/CR-6883',
    rule: 'Nominal rate times the product of the graded shaping factors, floored at 1.0E-05.',
  },
  therp: {
    name: 'THERP',
    source: 'NUREG/CR-1278, Appendix G Table G-1',
    rule: 'Base rate keyed by the type of error, then shaped. The method calls its own values conservative.',
  },
  heart: {
    name: 'HEART',
    source: 'HSE RR679; the 1.2-30 factor band from NARA in IAEA PUB2102',
    rule: 'Generic error probability times each condition at its assumed impact, capped at 1.0.',
  },
};

const procedure = procedureById('OP-TRF-014');
const persona = PERSONAS.find((p) => p.id === PERSONA_ID) ?? PERSONAS[0];
const plant = PLANTS.find((p) => p.id === PLANT_ID) ?? PLANTS[0];
const featureStep: Step = procedure.steps.find((s) => s.id === STEP_ID) ?? procedure.steps[0];

function conditionsForStep(step: Step) {
  return conditionsFor(
    step, persona, plant,
    { slipRatio: 1.12, alarmRinging: false, hazardSeen: false, setup },
    (procedure.warnings ?? []).map((w) => ({ cond: w.cond, level: w.level, steps: w.steps })),
  );
}

function hepFor(step: Step, method: HraMethod): HepResult {
  const conditions = conditionsForStep(step);
  const worksheet = assess({ step, persona, plant, alarmRinging: false }, conditions);
  return computeHep({
    method,
    kind: step.kind,
    similarity: step.similarity,
    insideProcedure: step.applies !== undefined || step.verify !== undefined,
    psfs: worksheet.rows,
    gtt: step.gtt,
  });
}

// the featured step: one worksheet, read through all three methods
const featureConditions = conditionsForStep(featureStep);
const featureWorksheet = assess({ step: featureStep, persona, plant, alarmRinging: false }, featureConditions);
const featureRows = HRA_METHODS.map((method) => ({
  method,
  hep: computeHep({
    method,
    kind: featureStep.kind,
    similarity: featureStep.similarity,
    insideProcedure: featureStep.applies !== undefined || featureStep.verify !== undefined,
    psfs: featureWorksheet.rows,
    gtt: featureStep.gtt,
  }),
}));
const activeConditions = (Object.keys(featureConditions) as ConditionId[])
  .map((c) => ({ id: c, level: featureConditions[c] ?? 0 }))
  .filter((x) => x.level > 0);

// the ranking check: every step, under every method, computed here at render time
const ranked = HRA_METHODS.map((method) => {
  const rows = procedure.steps
    .map((step) => ({ id: step.id, title: step.title, p: hepFor(step, method).p }))
    .sort((a, b) => b.p - a.p);
  return { method, positions: new Map(rows.map((r, i) => [r.id, i + 1])) };
});
const rankOf = (stepId: string, method: HraMethod) =>
  ranked.find((r) => r.method === method)?.positions.get(stepId) ?? 0;

const twin = getTwin('tank_transfer');
const tp = twin.params;
const rt2 = (tp.hAh - tp.hAl) * tp.area / (tp.qPump / 3600);
const rt3 = (tp.hOverflow - tp.hAh) * tp.area / (tp.qPump / 3600);
const responseRequired = tp.walkS + tp.actS;
const startFrac = plant.freeboardPct ?? 0.49;
const endLevel = tp.hOverflow * startFrac + tp.batchM3 / tp.area;
const freeboard = tp.hOverflow - endLevel;

const autoStopCost = interventionById('automate_stop')?.effect.annualCostEur ?? 0;
const walkdownCost = interventionById('isolation_reconcile')?.effect.annualCostEur ?? 0;

const pct = (v: number) => (v < 5e-4 ? v.toExponential(1) : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);
const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;

export default function Method() {
  return (
    <main className="min-h-screen bg-void text-bone">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-[1100px] flex-wrap items-baseline gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/" className="text-[17px] tracking-[0.3em] text-amber">MURPHY</Link>
          <span className="label">method - where the numbers come from</span>
          <Link
            href="/"
            className="ml-auto border border-rule px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-ash hover:border-ash hover:text-bone"
          >
            back to the console
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <section className="panel p-6">
          <h1 className="font-serif text-[34px] leading-[1.15] text-bone">
            Every figure on this screen is a row from a published table.
          </h1>
          <p className="sop-text mt-4 max-w-[760px]">
            A procedure is treated as an executable object, not as a text. Each step names an action, the cue it
            depends on, and the plant variables it changes. Reliability comes from three independent methods read
            against the same model.
          </p>
          <p className="sop-text mt-3 max-w-[760px]">
            A finding is only kept when the ranking of failure modes survives a change of method. The absolute
            level is never better than order of magnitude. The source documents say so, and pretending otherwise
            is how a tool like this gets ignored by the engineers who would have to trust it.
          </p>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">The three methods</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {HRA_METHODS.map((m) => (
              <div key={m} className="border border-rule bg-graphite p-4">
                <p className="readout text-[15px] text-bone">{METHOD_META[m].name}</p>
                <p className="label mt-1">{METHOD_META[m].source}</p>
                <p className="mt-3 text-[12px] leading-relaxed text-ash">{METHOD_META[m].rule}</p>
                {m === 'sparh' && (
                  <p className="readout mt-3 text-[11px] text-cyan">
                    nominal {SPAR_NOMINAL.action.toExponential(1)} action, {SPAR_NOMINAL.diagnosis.toExponential(1)}{' '}
                    diagnosis, floor {SPAR_FLOOR.toExponential(1)}
                  </p>
                )}
                {m === 'therp' && (
                  <p className="readout mt-3 text-[11px] text-cyan">
                    general first estimate {THERP_BASE.general_first_estimate.p} - band factor x{THERP_ERROR_FACTOR}
                  </p>
                )}
                {m === 'heart' && (
                  <p className="readout mt-3 text-[11px] text-cyan">
                    condition factors 1.2 to {HEART_EPC_MAX} - APOA {APOA_BY_LEVEL.slice(1).join(' / ')}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="sop-text mt-5 max-w-[780px]">
            SPAR-H multiplies the nominal rate by the product of every shaping factor applied. When three or more
            are negative, the published adjustment replaces that product with{' '}
            <span className="readout text-bone">NHEP x C / (1 + NHEP x (C - 1))</span>. A badly shaped step lands
            near 0.8, not at 40.
          </p>
          <p className="sop-text mt-3 max-w-[780px]">
            <span className="text-vermillion">Not used, deliberately.</span> The reprinted THERP action-class
            ladder, Ps 0.9999, 0.999 and 0.995, and the PSF multipliers quoted as x10, x20 and x100 appear in a
            great many secondary papers. They are not in the primary documents.
          </p>
          <p className="sop-text mt-3 max-w-[780px]">
            <span className="text-vermillion">At most {MAX_NEGATIVE_PSFS} negative factors act on one step.</span>{' '}
            Fatigued, rushed and poor procedure are frequently one situation described three times. The extras are
            held at nominal and listed as suppressed, here on screen, where an engineer can overrule the call.
          </p>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">
            SPAR-H performance shaping factors, as published
          </h2>
          <p className="label mt-2">multiplier on the nominal human error probability, level by level</p>
          <div className="mt-4 space-y-2">
            {PSF_REFERENCE.map((f) => (
              <div key={f.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-b border-rule pb-2">
                <span className="readout w-[220px] shrink-0 text-[13px] text-bone">
                  {f.id} <span className="text-ash">- {f.label}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {f.levels.map((l) => {
                    const tone = l.fails ? 'text-vermillion border-vermillion/50'
                      : l.mult > 1 ? 'text-vermillion/90 border-rule'
                        : l.mult < 1 ? 'text-phosphor border-rule' : 'text-ash border-rule';
                    return (
                      <span key={l.name} className={`readout border px-2 py-0.5 text-[11px] ${tone}`}>
                        {l.name} <span className="text-bone">x{l.mult}</span>
                        {l.fails ? ' - action unachievable' : ''}
                      </span>
                    );
                  })}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="panel p-6">
            <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">THERP base rates, Table G-1</h2>
            <p className="label mt-2">keyed by the type of error, which is how a step is written</p>
            <table className="readout mt-4 w-full text-[12px]">
              <tbody>
                {Object.entries(THERP_BASE).map(([k, v]) => (
                  <tr key={k} className="border-b border-rule/60">
                    <td className="whitespace-nowrap py-1.5 pr-3 align-top text-cyan">{v.p.toExponential(0)}</td>
                    <td className="py-1.5 align-top text-ash">{v.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel p-6">
            <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">HEART generic task types</h2>
            <p className="label mt-2">generic error probability, then condition factors</p>
            <table className="readout mt-4 w-full text-[12px]">
              <tbody>
                {Object.entries(HEART_GTT).map(([k, v]) => (
                  <tr key={k} className="border-b border-rule/60">
                    <td className="py-1.5 pr-3 align-top text-cyan">{k}</td>
                    <td className="whitespace-nowrap py-1.5 pr-3 align-top text-bone">{v.gep}</td>
                    <td className="py-1.5 align-top text-ash">{v.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-[12px] leading-relaxed text-ash">
              The maximum factor of a condition is taken from the published 1.2 to {HEART_EPC_MAX} band, then
              scaled by the assumed probabilistic impact on the task. Treating every condition as a x
              {HEART_EPC_MAX} one is how a method ends up reporting 100%.
            </p>
          </div>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Worked example, computed on this page</h2>
          <p className="label mt-2">
            {procedure.id} rev {procedure.revision} - step {featureStep.id} - {persona.label} - {plant.label}
          </p>
          <p className="sop-text mt-4 max-w-[780px]">
            <span className="text-bone">&quot;{featureStep.title}.&quot;</span> The instruction the operator reads
            is:
          </p>
          <p className="sop-text mt-2 max-w-[780px] border-l-2 border-amber/60 pl-4 text-[14px]">
            {featureStep.text}
          </p>
          <p className="mt-3 text-[12px] text-ash">
            action kind <span className="text-bone">{featureStep.kind}</span> - cue{' '}
            <span className="text-bone">{featureStep.cue}</span> - {featureStep.similarity ?? 1} confusable
            devices - nominal duration {featureStep.durS} s - error modes {featureStep.errors?.length ?? 0}
          </p>

          <p className="label mt-6">error producing conditions active for this performance</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {activeConditions.map((c) => (
              <div key={c.id} className="border border-rule bg-graphite px-3 py-2">
                <span className="label">{CONDITION_LABELS[c.id]}</span>
                <p className="readout mt-1 text-[12px] text-amber">{c.id} - severity {c.level}</p>
              </div>
            ))}
          </div>

          <p className="label mt-6">the worksheet all three methods read</p>
          <table className="readout mt-2 w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th className="py-2 pr-3 text-[10px] uppercase tracking-[0.14em] text-ash">Factor</th>
                <th className="py-2 pr-3 text-[10px] uppercase tracking-[0.14em] text-ash">Level applied</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">x</th>
                <th className="py-2 text-[10px] uppercase tracking-[0.14em] text-ash">Why</th>
              </tr>
            </thead>
            <tbody>
              {featureWorksheet.rows.map((r, i) => {
                const mult = PSF_REFERENCE.find((f) => f.id === r.psf)?.levels[r.levelIndex].mult ?? 1;
                return (
                  <tr key={`${r.psf}-${i}`} className="border-b border-rule/50 align-top">
                    <td className="py-1.5 pr-3 text-bone">{r.psf}</td>
                    <td className={`py-1.5 pr-3 ${mult > 1 ? 'text-vermillion' : mult < 1 ? 'text-phosphor' : 'text-ash'}`}>
                      {CONDITION_LABELS[r.psf as ConditionId] ?? r.why.split(' - ')[0]}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-bone">{mult}</td>
                    <td className="py-1.5 text-[11px] text-ash">{r.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {featureWorksheet.suppressed.length > 0 && (
            <div className="mt-3 border border-vermillion/40 bg-vermillion/5 p-3">
              <p className="label text-vermillion">
                held at nominal - past {MAX_NEGATIVE_PSFS} they would re-count one cause
              </p>
              <ul className="mt-2 space-y-1 text-[11px] text-ash">
                {featureWorksheet.suppressed.map((s) => (
                  <li key={`${s.psf}-${s.levelIndex}`}>{s.psf}: {s.why}</li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="mt-7 text-[12px] uppercase tracking-[0.18em] text-bone">
            One worksheet, three published methods
          </h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {featureRows.map(({ method, hep }) => (
              <div key={method} className="border border-rule bg-graphite p-4">
                <p className="label">{METHOD_META[method].name}</p>
                <p className="readout mt-2 text-[26px] leading-none text-amber">{pct(hep.p)}</p>
                <p className="readout mt-2 text-[11px] text-ash">band {pct(hep.lo)} to {pct(hep.hi)}</p>
                <p className="readout mt-3 text-[11px] text-cyan">
                  nominal {hep.nominal.toExponential(1)} - C {hep.multiplier.toFixed(2)}
                  {hep.adjusted ? ' - adjustment applied' : ''}
                </p>
                <p className="mt-3 text-[11px] leading-relaxed text-ash">{hep.basis}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Does the ranking survive a change of method?</h2>
          <p className="mt-3 text-[12px] leading-relaxed text-ash">
            This is the only test the three-method interface can honestly pass. Every step of {procedure.id} is
            quantified under all three methods for the same crew and the same plant state. Rank is the position in
            that method&apos;s own ordering of the steps, highest probability first.
          </p>
          <table className="readout mt-4 w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left">
                <th className="py-2 pr-3 text-[10px] uppercase tracking-[0.14em] text-ash">Step</th>
                <th className="py-2 pr-3 text-[10px] uppercase tracking-[0.14em] text-ash">Action</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">SPAR-H</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">rank</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">THERP</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">rank</th>
                <th className="py-2 pr-3 text-right text-[10px] uppercase tracking-[0.14em] text-ash">HEART</th>
                <th className="py-2 text-right text-[10px] uppercase tracking-[0.14em] text-ash">rank</th>
              </tr>
            </thead>
            <tbody>
              {procedure.steps.map((step) => {
                const highlight = step.id === featureStep.id;
                return (
                  <tr key={step.id} className={`border-b border-rule/50 ${highlight ? 'bg-amber/5' : ''}`}>
                    <td className="py-1.5 pr-3 text-bone">
                      {step.id} <span className="text-ash">{step.title.slice(0, 34)}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-ash">{step.kind}</td>
                    {HRA_METHODS.map((method) => (
                      <td key={method} className="py-1.5 pr-3 text-right">
                        <span className={highlight ? 'text-amber' : 'text-bone'}>{pct(hepFor(step, method).p)}</span>
                      </td>
                    )).flatMap((cell, i) => {
                      const method = HRA_METHODS[i];
                      const rank = rankOf(step.id, method);
                      return [
                        cell,
                        <td key={`${step.id}-rank-${method}`} className="py-1.5 pr-3 text-right text-ash">{rank}</td>,
                      ];
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-[12px] leading-relaxed text-ash">
            The levels disagree by more than an order of magnitude. The order does not move much, and the steps
            that the batch later blames are near the top under every method. Where they do move, the finding is
            weaker and the interface says so.
          </p>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">The process twin</h2>
          <p className="sop-text mt-3 max-w-[780px]">
            {twin.label} - {twin.unit}. Mass balance sets the level: pump flow in through the inlet, draw-off
            out, plus a cross-connect off its seat still feeding the tank from the header. Discharge pressure
            seeks the running value when the line is open and the dead-head value when it is not.
          </p>
          <p className="sop-text mt-3 max-w-[780px]">
            Time above the sustained rating fails the line. With the vent shut, incoming volume compresses the
            vapour space until the roof seam gives. Every release fills the bund first, and whatever exceeds the
            remaining headroom escapes to drainage.
          </p>
          <p className="sop-text mt-3 max-w-[780px]">
            The second twin is a reheat furnace light-off: purge time against the required duration, unburnt gas
            inventory, water drive-out from a fresh lining, spalling when the ramp outruns it, and shell
            temperature as the visible sign.
          </p>
          <p className="sop-text mt-3 max-w-[780px]">
            Only <span className="readout text-bone">+ - * /</span>, comparisons and clamping appear in a state
            update. The physics holds no randomness and makes no transcendental call, so a browser, a CPU and a
            GPU return the same trajectory for the same scenario index.
          </p>

          <div className="mt-5 border border-rule bg-graphite p-4">
            <p className="label">response budget, reported by the twin itself</p>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[12px]">
              <span className="readout text-cyan">{rt2.toFixed(0)} s from alarm to independent trip</span>
              <span className="readout text-cyan">{rt3.toFixed(0)} s from trip to overflow</span>
              <span className={`readout ${responseRequired > rt2 ? 'text-vermillion' : 'text-phosphor'}`}>
                {responseRequired} s for a person to walk to the pump and stop it
              </span>
            </div>
            <div className="mt-3 flex h-3 w-full overflow-hidden bg-rule">
              <div className="h-3 bg-cyan/30" style={{ width: `${(rt2 / (rt2 + responseRequired)) * 100}%` }} />
              <div className={`h-3 ${responseRequired > rt2 ? 'bg-vermillion/60' : 'bg-phosphor/60'}`} style={{ width: `${(responseRequired / (rt2 + responseRequired)) * 100}%` }} />
            </div>
            <p className="readout mt-3 text-[12px] text-ash">
              start level {(tp.hOverflow * startFrac).toFixed(2)} m - end level {endLevel.toFixed(2)} m -{' '}
              {freeboard.toFixed(2)} m of freeboard left under the {tp.hOverflow} m overflow height
            </p>
            <p className="mt-3 text-[11px] leading-relaxed text-ash">
              These are model parameters, not measurements. The finding is the comparison. A procedure whose
              safety rests on a human action inside this window fails when freeboard shrinks, when the crew is
              new, or when the batch runs late.
            </p>
          </div>

          <p className="mt-4 text-[12px] leading-relaxed text-ash">
            Each step id hashes to a stable slot in the random stream. Scenario 41 sees the same crew, the same
            equipment state and the same draws in the baseline and in the candidate. That is what makes a
            before-and-after comparison paired, and what lets a shift you click on be recomputed rather than
            stored.
          </p>
        </section>

        <section className="panel p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">How a proposed control is accepted</h2>
          <ol className="sop-text mt-3 max-w-[820px] list-decimal space-y-2 pl-5">
            <li>A control is a typed mutation of the procedure or the configuration, tagged with its tier in the hierarchy of controls.</li>
            <li>The same scenario indices run again against it, and a paired bootstrap differences the two arms.</li>
            <li>The one-sided risk of a false positive must be under 2.5% on the failure rate, and expected loss must fall as well.</li>
            <li>
              The net annual gain must exceed the control&apos;s own annualised cost - {eur(autoStopCost)} for an
              independent automatic stop, {eur(walkdownCost)} for a pre-job walkdown that reconciles isolations.
            </li>
            <li>Benjamini-Hochberg correction runs across the whole candidate set, because twelve attempts will surface one winner by luck.</li>
            <li>The survivors are stacked into one revised procedure and re-tested together, since controls interact.</li>
          </ol>
          <p className="mt-4 text-[12px] leading-relaxed text-ash">
            Outcomes are classed normal, upset or incident before anyone prices them. An aborted batch and a loss
            of containment are not the same event, and a plant reports them to different people. Rejections stay
            on screen with their reasons, because most ideas do not work.
          </p>
        </section>

        <section className="panel border-vermillion/30 p-6">
          <h2 className="text-[13px] uppercase tracking-[0.2em] text-vermillion">Limitations</h2>
          <div className="sop-text mt-3 space-y-3">
            <p>
              Human reliability data are order-of-magnitude screening values. Every result carries a band, and the
              band is wide on purpose. A modelled 0.4% and a modelled 1.2% are the same quantity.
            </p>
            <p>
              A simulated crew is a hypothesis about a crew. It is built from years of experience, hours into a
              shift, prior runs of this procedure and a working language. It is not a person&apos;s record, and it
              does not replace watching the people who actually do the job.
            </p>
            <p>
              The process twins are engineered surrogates. They were checked against the mechanics published in
              incident investigations, not against computational fluid dynamics. Use them to compare procedures
              with each other, not to size a relief valve.
            </p>
            <p>
              A change order only becomes real when a competent person signs it. These statistics decide whether
              an edit is worth proposing. Management of change, a field walkdown and a signature still carry the
              weight, and this replaces none of them.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/"
              className="border border-amber bg-amber/15 px-4 py-2.5 text-[12px] uppercase tracking-[0.18em] text-amber hover:bg-amber/25"
            >
              back to the console
            </Link>
            <Link
              href="/"
              className="border border-rule px-4 py-2.5 text-[12px] uppercase tracking-[0.18em] text-ash hover:border-ash hover:text-bone"
            >
              read the full method in docs/METHOD.md
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
