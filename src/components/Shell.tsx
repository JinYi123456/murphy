'use client';

import Link from 'next/link';
import { PERSONAS, PLANTS, PROCEDURES, CONTROL_CATALOGUE } from '../lib/registry';
import type { ConsoleStore } from '../lib/useConsole';
import type { ViewId } from '../lib/useConsole';
import { LineMap } from './LineMap';
import { BlackBox } from './BlackBox';
import { PressureTest } from './PressureTest';
import { ChangeLab } from './ChangeLab';
import { Evidence } from './Evidence';
import { StepInspector } from './StepInspector';

const VIEWS: { id: ViewId; label: string; hint: string }[] = [
  { id: 'line', label: 'Line map', hint: 'where the procedure breaks' },
  { id: 'pressure', label: 'Pressure test', hint: 'thousands of crews, one seed each' },
  { id: 'blackbox', label: 'Black box', hint: 'replay a shift that failed' },
  { id: 'lab', label: 'Change lab', hint: 'prove an edit before you make it' },
  { id: 'evidence', label: 'Evidence', hint: 'what ran, where, and what it cost' },
];

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;

function Chip({ ok, children, title }: { ok: boolean | null; children: React.ReactNode; title: string }) {
  const colour = ok === null ? 'var(--color-ash)' : ok ? 'var(--color-phosphor)' : 'var(--color-vermillion)';
  return (
    <span title={title} className="flex items-center gap-1.5 border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.16em]" style={{ color: colour }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: colour }} />
      {children}
    </span>
  );
}

/**
 * The instrument face: one screen, the configuration you are testing always
 * visible, and a permanent read-out of which machine produced the numbers.
 */
export function Shell({ s }: { s: ConsoleStore }) {
  const plant = PLANTS.find((p) => p.id === s.cfg.plantId)!;
  const persona = PERSONAS.find((p) => p.id === s.cfg.personaId)!;
  const proc = PROCEDURES.find((p) => p.id === s.cfg.procedureId)!;

  return (
    <main className="min-h-screen bg-void text-bone">
      <header className="sticky top-0 z-40 border-b border-rule bg-void/92 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
          <div className="flex items-baseline gap-3">
            <Link href="/" className="text-[19px] leading-none tracking-[0.3em] text-amber">MURPHY</Link>
            <span className="hidden text-[11px] text-ash sm:inline">
              fuzz the procedure, not the plant
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Chip
              ok={s.where === 'amd' ? true : s.health?.backends.amd.reachable ? null : false}
              title={s.health?.backends.amd.error ?? 'AMD Instinct batched kernel'}
            >
              {s.where === 'amd' ? `ran on ${s.device ?? 'amd'}` : s.health?.backends.amd.reachable ? 'amd ready' : 'amd not attached'}
            </Chip>
            <Chip ok={s.health?.backends.llm.configured ?? null} title={s.health?.backends.llm.note ?? 'open model served on AMD'}>
              {s.health?.backends.llm.model ?? 'model on amd'}
            </Chip>
            <Chip ok={s.health?.backends.evolus.configured ?? null} title="Evolus workflows, extractors, knowledge">
              evolus
            </Chip>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {s.summary && (
              <div className="hidden items-baseline gap-4 md:flex">
                <Stat label="failure" value={`${(s.summary.failureRate * 100).toFixed(2)}%`} tone={s.summary.failureRate > 0.02 ? 'bad' : 'good'} />
                <Stat label="exposure / yr" value={eur(s.summary.annualLossEur)} tone={s.summary.annualLossEur > 1_000_000 ? 'bad' : 'ok'} />
                <Stat label="shifts/s" value={s.summary.shiftsPerSecond.toFixed(0)} tone="neutral" />
              </div>
            )}
            <button
              onClick={() => s.run({ onAmd: false })}
              disabled={s.running}
              className="border border-rule bg-panel px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-bone enabled:hover:border-amber disabled:opacity-40"
            >
              {s.running ? 'running' : 'run here'}
            </button>
            <button
              onClick={() => s.run({ onAmd: true })}
              disabled={s.running}
              className="border border-amber-dim bg-amber/12 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-amber enabled:hover:bg-amber/20 disabled:opacity-40"
            >
              run on amd
            </button>
          </div>
        </div>

        {/* the configuration under test is part of the figure, not a settings menu */}
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-end gap-x-4 gap-y-3 border-t border-rule px-5 py-3">
          <Select label="procedure" value={s.cfg.procedureId} onChange={(v) => s.setCfg({ procedureId: v })}
            options={PROCEDURES.map((p) => ({ value: p.id, label: `${p.id} rev ${p.revision}` }))} />
          <Select label="who performs it" value={s.cfg.personaId} onChange={(v) => s.setCfg({ personaId: v })}
            options={PERSONAS.map((p) => ({ value: p.id, label: p.label }))} title={persona.notes} />
          <Select label="plant state" value={s.cfg.plantId} onChange={(v) => s.setCfg({ plantId: v })}
            options={PLANTS.filter((p) => !p.twin || p.twin === proc.twin).map((p) => ({ value: p.id, label: p.label }))} title={plant.notes} />
          <Select label="method" value={s.cfg.method} onChange={(v) => s.setCfg({ method: v as 'sparh' | 'therp' | 'heart' })}
            options={[
              { value: 'sparh', label: 'SPAR-H' },
              { value: 'therp', label: 'THERP' },
              { value: 'heart', label: 'HEART' },
            ]} title="three published human-reliability methods over the same model" />
          <label className="flex min-w-[190px] flex-col gap-1">
            <span className="label">shifts {s.cfg.n.toLocaleString('en-US')}</span>
            <input
              type="range" min={500} max={60000} step={500} value={s.cfg.n}
              onChange={(e) => s.setCfg({ n: Number(e.target.value) })}
              className="scrub w-full"
            />
          </label>
          <label className="flex min-w-[150px] flex-col gap-1">
            <span className="label">seed</span>
            <input
              value={s.cfg.seed}
              onChange={(e) => s.setCfg({ seed: e.target.value })}
              className="border border-rule bg-graphite px-2 py-1 text-[12px] text-bone outline-none focus:border-amber"
            />
          </label>

          {s.cfg.controls.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="label">controls</span>
              {s.cfg.controls.map((id) => {
                const c = CONTROL_CATALOGUE.find((x) => x.id === id)!;
                return (
                  <button key={id} onClick={() => s.toggleControl(id)}
                    title="click to remove this control and re-fuzz"
                    className="border border-phosphor/40 bg-phosphor/10 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-phosphor">
                    {c.id} ×
                  </button>
                );
              })}
            </div>
          )}

          <nav className="ml-auto flex gap-1">
            {VIEWS.map((v) => (
              <button key={v.id} onClick={() => s.setView(v.id)} title={v.hint}
                className={`border px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] ${
                  s.view === v.id ? 'border-amber bg-amber/15 text-amber' : 'border-rule text-ash hover:border-ash hover:text-bone'
                }`}>
                {v.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {s.running && (
        <div className="relative h-[2px] w-full overflow-hidden bg-rule">
          <div className="absolute inset-y-0 w-1/3 bg-amber sweep" />
        </div>
      )}

      {s.error && (
        <div className="mx-auto max-w-[1600px] px-5 pt-3">
          <p className="border border-vermillion/40 bg-vermillion/8 px-3 py-2 text-[12px] text-vermillion">{s.error}</p>
        </div>
      )}

      {!s.summary && !s.running && (
        <Intro onRun={() => s.run({ onAmd: false })} />
      )}

      <section className="mx-auto max-w-[1600px] px-5 py-5">
        {s.summary && s.view === 'line' && <LineMap s={s} />}
        {s.summary && s.view === 'pressure' && <PressureTest s={s} />}
        {s.summary && s.view === 'blackbox' && <BlackBox s={s} />}
        {s.summary && s.view === 'lab' && <ChangeLab s={s} />}
        {s.view === 'evidence' && <Evidence s={s} />}
        {s.selectedStep && s.summary && <StepInspector s={s} />}
      </section>

      <footer className="mx-auto max-w-[1600px] px-5 pb-10 pt-2 text-[11px] leading-relaxed text-ash">
        <p className="max-w-[900px]">
          MURPHY ranks where a procedure is most likely to fail. It does not predict the future: human
          reliability data are order-of-magnitude screening values, the process models are engineered
          surrogates, and every figure on this screen carries the derivation that produced it. A finding is
          a hypothesis worth going to look at, and a change order only becomes real when a competent person
          signs it.
        </p>
      </footer>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'ok' | 'neutral' }) {
  const colour = tone === 'bad' ? 'text-vermillion' : tone === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="label">{label}</span>
      <span className={`readout text-[15px] ${colour}`}>{value}</span>
    </div>
  );
}

function Select({ label, value, onChange, options, title }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; title?: string;
}) {
  return (
    <label className="flex min-w-[210px] flex-col gap-1" title={title}>
      <span className="label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-rule bg-graphite px-2 py-1 text-[12px] text-bone outline-none focus:border-amber"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function Intro({ onRun }: { onRun: () => void }) {
  return (
    <section className="mx-auto max-w-[1000px] px-6 py-16">
      <h1 className="font-serif text-[42px] leading-[1.12] text-bone">
        Software has fuzzing.<br />
        <span className="text-amber">Operating procedures have nothing.</span>
      </h1>
      <p className="sop-text mt-6 max-w-[720px]">
        Every plant runs the same ceremony: a hazard review, a written procedure, a signature, and then a
        tired person at 3am doing it anyway. Nobody tests the procedure. MURPHY does what developers have
        done to code for forty years - it throws a few thousand error-prone crews at the written sequence,
        against a physics twin of the equipment, and reports which station the line fails at, how much the
        company pays for it a year, and which change would measurably fix it.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button onClick={onRun} className="border border-amber bg-amber/15 px-4 py-2.5 text-[12px] uppercase tracking-[0.18em] text-amber hover:bg-amber/25">
          fuzz a tank transfer
        </button>
        <a href="/method" className="border border-rule px-4 py-2.5 text-[12px] uppercase tracking-[0.18em] text-ash hover:border-ash hover:text-bone">
          how the numbers are derived
        </a>
      </div>
      <p className="mt-8 text-[11px] text-ash">
        17 steps, 4 plant states, 6 crews, 12 candidate controls. Runs in your browser; the same kernel
        runs batched on AMD Instinct.
      </p>
    </section>
  );
}
