'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import type { ShiftDto } from '../lib/dto';
import { getTwin } from '../engine/twins/index';
import { costOf } from '../engine/economics';

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;

/**
 * Black box replay.
 *
 * A failed shift is not stored anywhere: it is recomputed from the seed and the
 * scenario index, which is the same property a flight recorder gives you when
 * you put the tape back on the desk. The plant on the left and the procedure on
 * the right share one clock, so the moment a deviation stops being an
 * abstraction is the moment the physics starts to disagree with the paperwork.
 */
export function BlackBox({ s }: { s: ConsoleStore }) {
  const shift = s.activeShift;
  const [tS, setTS] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [sound, setSound] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);
  const last = useRef(0);

  const twin = getTwin(s.run_config.procedure.twin);
  const total = shift?.elapsedS ?? 0;

  useEffect(() => {
    if (!playing || !shift) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last.current) / 1000) * speed;
      last.current = now;
      setTS((prev) => {
        const next = prev + dt;
        if (next >= shift.elapsedS) {
          setPlaying(false);
          return shift.elapsedS;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed, shift]);

  const ping = useCallback((kind: string) => {
    if (!sound) return;
    audio.current ??= new AudioContext();
    const ctx = audio.current;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = kind === 'error' ? 220 : kind === 'alarm' ? 660 : 440;
    o.type = kind === 'error' ? 'square' : 'sine';
    g.gain.value = 0.05;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.08);
  }, [sound]);

  const frame = useMemo(() => {
    if (!shift || !shift.series.length) return null;
    let lo = 0;
    let hi = shift.series.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shift.series[mid].tS < tS) lo = mid + 1;
      else hi = mid;
    }
    return shift.series[lo];
  }, [shift, tS]);

  const passed = useMemo(() => {
    if (!shift) return [] as ShiftDto['trace'];
    return shift.trace.filter((e) => e.tS <= tS);
  }, [shift, tS]);

  useEffect(() => {
    const newest = passed[passed.length - 1];
    if (newest && (newest.kind === 'error' || newest.kind === 'alarm')) ping(newest.kind);
  }, [passed.length, ping]);

  const costSoFar = useMemo(() => {
    if (!frame) return 0;
    const partial = { ...shift!.peak };
    // money accrues with what has physically left the containment so far
    const scale = shift!.peak.releaseM3 > 0 ? Math.min(1, frame.v.release / shift!.peak.releaseM3) : 0;
    void partial;
    const full = costOf(s.run_config.procedure.twin, shift!.outcome, shift!.peak, s.run_config.plant.product ?? 'default').totalEur;
    return full * scale;
  }, [frame, shift, s.run_config]);

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Black box</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="label">recordings</span>
          {s.traced.length === 0 && <span className="text-[11px] text-ash">run a pressure test to collect the worst shifts</span>}
          {s.traced.map((tr) => (
            <button key={tr.scn}
              onClick={() => { s.setActiveShift(tr); setTS(0); setPlaying(true); }}
              className={`border px-2 py-1 text-[10px] uppercase tracking-[0.1em] ${
                shift?.scn === tr.scn ? 'border-amber text-amber' : 'border-rule text-ash hover:border-ash'
              }`}>
              #{tr.scn} {tr.outcome}
            </button>
          ))}
        </div>
        <button
          onClick={async () => {
            const scn = Number(prompt('replay scenario index', '7'));
            if (!Number.isFinite(scn)) return;
            const sh = await s.loadReplay(scn);
            void sh;
            setTS(0);
          }}
          className="border border-rule px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-ash hover:border-amber hover:text-amber">
          replay any seed
        </button>
      </div>

      {!shift ? (
        <p className="py-16 text-center text-[12px] text-ash">
          No shift loaded. Pick a recording above, or click a hot station on the line map.
        </p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
            <Plant twin={twin.id} frame={frame} outcome={shift.outcome} />

            <div className="flex min-h-[300px] flex-col border border-rule bg-graphite">
              <div className="flex items-center justify-between border-b border-rule px-3 py-2">
                <span className="label">procedure tape</span>
                <span className="readout text-[12px] text-amber">
                  T+{tS.toFixed(0).padStart(4, '0')}s / {shift.elapsedS.toFixed(0)}s
                </span>
              </div>
              <ul className="tape-scroll-holder flex-1 overflow-y-auto px-3 py-2" style={{ maxHeight: 300 }}>
                {shift.trace.map((e, i) => {
                  const on = e.tS <= tS;
                  const isNow = passed.length - 1 === i;
                  return (
                    <li key={`${e.tS}-${i}`}
                      className={`flex gap-3 border-b border-rule/40 py-1 text-[11px] transition-opacity duration-200 ${
                        on ? 'opacity-100' : 'opacity-25'
                      }`}
                      style={{ background: isNow ? 'rgba(255,176,58,0.08)' : undefined }}>
                      <span className="w-[58px] shrink-0 readout text-ash">{e.tS.toFixed(0)}s</span>
                      <span className={`w-[74px] shrink-0 uppercase tracking-[0.1em] ${tone(e.kind)}`}>{e.kind}</span>
                      <span className="min-w-0">
                        <span className="text-bone">{e.label}</span>
                        {e.detail && <span className="text-ash"> - {e.detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="mt-4">
            <input type="range" min={0} max={Math.max(1, total)} step={1} value={tS}
              onChange={(e) => { setTS(Number(e.target.value)); setPlaying(false); }}
              className="scrub w-full" aria-label="replay position" />
            <div className="relative mt-1 h-4">
              {shift.trace.filter((e) => e.kind === 'error' || e.kind === 'alarm' || e.kind === 'hazard').map((e, i) => (
                <span key={i} title={`${e.tS.toFixed(0)}s ${e.label}`}
                  className="absolute top-0 h-3 w-[2px]"
                  style={{
                    left: `${total ? (e.tS / total) * 100 : 0}%`,
                    background: e.kind === 'error' ? '#ff4a2f' : e.kind === 'hazard' ? '#ff4a2f' : '#4fd8ff',
                  }} />
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button onClick={() => setPlaying((p) => !p)}
                className="border border-amber bg-amber/15 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-amber">
                {playing ? 'hold' : 'replay'}
              </button>
              <div className="flex items-center gap-1">
                {[1, 10, 30, 120].map((v) => (
                  <button key={v} onClick={() => setSpeed(v)}
                    className={`border px-2 py-1 text-[10px] uppercase ${speed === v ? 'border-amber text-amber' : 'border-rule text-ash'}`}>
                    {v}x
                  </button>
                ))}
              </div>
              <button onClick={() => setSound((x) => !x)}
                className={`border px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${sound ? 'border-cyan text-cyan' : 'border-rule text-ash'}`}>
                tape audio {sound ? 'on' : 'off'}
              </button>
              <span className="ml-auto flex items-center gap-4 text-[11px]">
                <Readout label="released" value={`${(frame?.v.release ?? 0).toFixed(2)} m3`} tone={(frame?.v.release ?? 0) > 0 ? 'bad' : 'good'} />
                <Readout label="level" value={`${(frame?.v.level ?? 0).toFixed(2)} m`} />
                <Readout label="cost so far" value={eur(costSoFar)} tone={costSoFar > 1000 ? 'bad' : 'neutral'} />
                <Readout label="outcome" value={shift.outcome} tone={shift.failed ? 'bad' : 'good'} />
              </span>
            </div>

            {shift.note && (
              <p className="mt-3 border-l-2 border-vermillion pl-3 text-[12px] text-vermillion">{shift.note}</p>
            )}
            <p className="mt-3 text-[11px] text-ash">
              scenario #{shift.scn} of seed {shift.method.toUpperCase()} - this trajectory was recomputed from
              the seed, not stored, so replaying it after resizing the batch gives the same tape.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function tone(kind: string): string {
  if (kind === 'error') return 'text-vermillion';
  if (kind === 'hazard') return 'text-vermillion';
  if (kind === 'alarm') return 'text-cyan';
  if (kind === 'recovery') return 'text-phosphor';
  if (kind === 'outcome') return 'text-amber';
  return 'text-ash';
}

function Readout({ label, value, tone: t = 'neutral' }: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const colour = t === 'bad' ? 'text-vermillion' : t === 'good' ? 'text-phosphor' : 'text-bone';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label">{label}</span>
      <span className={`readout text-[13px] ${colour}`}>{value}</span>
    </span>
  );
}

/** The physical half of the screen: what the plant was doing while the tape ran. */
function Plant({ twin, frame, outcome }: { twin: string; frame: ShiftDto['series'][number] | null; outcome: string }) {
  if (!frame) return <div className="min-h-[300px] border border-rule" />;
  const v = frame.v;
  const d = frame.d;
  const breach = v.roofFailed > 0 || outcome === 'tank_breach';
  const overflow = v.overflowed === 1;
  const levelFrac = Math.min(1.08, v.level / 10);
  const pressFrac = Math.min(1, v.tankP / 45);
  const lineFrac = Math.min(1, v.lineP / 82);

  return (
    <div className="relative min-h-[300px] overflow-hidden border border-rule bg-graphite p-3">
      <div className="flex items-center justify-between">
        <span className="label">{twin === 'tank_transfer' ? 'TK-101, rack 3' : 'furnace 4'}</span>
        <span className="label">recorded</span>
      </div>

      <div className="mt-2 flex h-[236px] gap-4">
        {twin === 'tank_transfer' ? (
          <svg viewBox="0 0 150 210" className="h-full">
            <rect x="20" y="14" width="90" height="180" fill="#0b0d10" stroke="#3b4552" />
            <rect x="20" y="14" width="90" height="4" fill="#3b4552" />
            {/* liquid */}
            <rect x="21" y={194 - 178 * Math.min(1, levelFrac)} width="88" height={178 * Math.min(1, levelFrac)}
              fill="#4fd8ff" opacity="0.28" />
            {/* set points */}
            {[
              { y: 194 - 178 * (9.3 / 10), c: '#ffb03a', t: 'LAH 9.30' },
              { y: 194 - 178 * (9.6 / 10), c: '#a37bff', t: 'LAHH 9.60' },
              { y: 194 - 178, c: '#ff4a2f', t: 'overflow 10.00' },
            ].map((m) => (
              <g key={m.t}>
                <line x1="14" x2="116" y1={m.y} y2={m.y} stroke={m.c} strokeDasharray="3 2" strokeWidth="1" opacity="0.8" />
                <text x="120" y={m.y + 3} fontSize="7" fill={m.c}>{m.t}</text>
              </g>
            ))}
            {breach && <path d="M20 14 L110 14 L95 4 L35 4 Z" fill="#ff4a2f" opacity="0.7" />}
            {overflow && <rect x="20" y="10" width="90" height="6" fill="#ff4a2f" opacity="0.85" />}
            {/* released product on the deck */}
            <rect x="8" y="196" width="134" height={Math.min(10, v.spill * 2)} fill="#ff4a2f" opacity="0.55" />
            <text x="8" y="208" fontSize="7" fill="#8a95a3">bund {v.bund.toFixed(1)} m3 of 55</text>
          </svg>
        ) : (
          <svg viewBox="0 0 150 210" className="h-full">
            <rect x="18" y="30" width="114" height="130" fill="#0b0d10" stroke="#3b4552" />
            <rect x="18" y="30" width="114" height="130"
              fill="#ff7a2f" opacity={Math.max(0, Math.min(0.85, (v.zoneT - 100) / 1200))} />
            <rect x="18" y="30" width="114" height="130" fill="none" stroke={v.shellT > 260 ? '#ff4a2f' : '#3b4552'} strokeWidth="3" />
            <text x="24" y="24" fontSize="8" fill="#ffb03a">zone {v.zoneT.toFixed(0)} C</text>
            <text x="90" y="24" fontSize="8" fill={v.shellT > 260 ? '#ff4a2f' : '#8a95a3'}>shell {v.shellT.toFixed(0)} C</text>
            <text x="24" y="176" fontSize="8" fill={v.gasAccum > 6 ? '#ff4a2f' : '#8a95a3'}>unburnt gas {v.gasAccum.toFixed(1)} m3</text>
            <text x="24" y="190" fontSize="8" fill="#8a95a3">lining moisture {v.moisture.toFixed(1)} %, damage {v.damage.toFixed(2)}</text>
          </svg>
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Gauge label="pump discharge" value={v.lineP} unit="bar" frac={lineFrac} danger={25} max={82} running={d.PUMP === 1} />
          <Gauge label="vapour space" value={v.tankP} unit="mbar" frac={pressFrac} danger={45} max={45} running />
          <Gauge label="received by TK-101" value={v.delivered} unit="m3" frac={v.delivered / 55} danger={56} max={60} running />
          <div className="mt-1 grid grid-cols-4 gap-1">
            {(['V1', 'V2', 'V3', 'V4'] as const).map((k) => (
              <Valve key={k} id={k} open={d[k] === 1} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px]">
            <Pill on={d.PUMP === 1} label="P-201 running" onColour="#ffb03a" />
            <Pill on={d.STOP === 1} label="stopped" onColour="#3ee08f" />
            <Pill on={d.LAH === 0} label="level alarm isolated" onColour="#ff4a2f" />
            <Pill on={d.PIS === 0} label="independent trip isolated" onColour="#ff4a2f" />
            <Pill on={d.V3LEAK === 1} label="cross-connect off its seat" onColour="#ff4a2f" />
            <Pill on={alarmOn(v, d)} label="high level alarm sounding" onColour="#4fd8ff" />
          </div>
          <p className="mt-auto text-[10px] leading-relaxed text-ash">
            The gauge the operator reads is {v.level.toFixed(2)} plus a standing error of{' '}
            {(d.gaugeBias ?? 0).toFixed(2)} m. The line above does not know that.
          </p>
        </div>
      </div>
    </div>
  );
}

function alarmOn(v: Record<string, number>, d: Record<string, number>): boolean {
  return v.lahLatched === 1 && d.STOP === 0;
}

function Gauge({ label, value, unit, frac, danger, max, running }: {
  label: string; value: number; unit: string; frac: number; danger: number; max: number; running?: boolean;
}) {
  const over = value >= danger;
  const w = Math.max(0, Math.min(1, frac)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className={`readout text-[12px] ${over ? 'text-vermillion' : 'text-bone'}`}>
          {value.toFixed(value > 100 ? 0 : 2)} {unit}
        </span>
      </div>
      <div className="relative mt-1 h-[7px] bg-void">
        <div className="absolute inset-y-0 left-0" style={{ width: `${w}%`, background: over ? '#ff4a2f' : '#ffb03a', opacity: running === false ? 0.3 : 0.85 }} />
        <div className="absolute inset-y-[-2px] w-[1px] bg-vermillion" style={{ left: `${Math.min(100, (danger / max) * 100)}%` }} />
        <div className="absolute inset-0 rule-dot" />
      </div>
    </div>
  );
}

function Valve({ id, open }: { id: string; open: boolean }) {
  return (
    <div className={`flex flex-col items-center border px-1 py-1 ${open ? 'border-phosphor/60 bg-phosphor/10' : 'border-rule'}`}>
      <span className={`text-[11px] ${open ? 'text-phosphor' : 'text-ash'}`}>{id}</span>
      <span className="text-[9px] uppercase tracking-[0.1em] text-ash">{open ? 'open' : 'shut'}</span>
    </div>
  );
}

function Pill({ on, label, onColour }: { on: boolean; label: string; onColour: string }) {
  return (
    <span className="flex items-center gap-1.5 border border-rule px-1.5 py-1" style={{ color: on ? onColour : '#4a5563' }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: on ? onColour : '#2a323d' }} />
      {label}
    </span>
  );
}
