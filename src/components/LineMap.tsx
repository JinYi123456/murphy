'use client';

import { useMemo, useState } from 'react';
import type { ConsoleStore } from '../lib/useConsole';
import { getTwin } from '../engine/twins/index';
import type { StepStatDto } from '../lib/dto';

const W = 1240;
const PAD_L = 58;
const PAD_R = 34;
const TERRAIN_TOP = 34;
const TERRAIN_H = 150;
const LINE_Y = 232;
const BUDGET_Y = 300;

const logMin = Math.log10(1e-5);
const logMax = Math.log10(0.5);

function heat(p: number): number {
  const t = (Math.log10(Math.max(1e-6, p)) - logMin) / (logMax - logMin);
  return Math.max(0, Math.min(1, t));
}

const eur = (v: number) => `EUR ${Math.round(v).toLocaleString('en-US')}`;

/**
 * The procedure drawn on its own time axis.
 *
 * Station spacing is proportional to how long the step is supposed to take, so
 * a forty-minute monitoring task and a ninety-second valve turn are not given
 * the same room. Underneath, the terrain is the modelled chance that the step
 * goes wrong for this crew in this plant state. Above it, the rings are what
 * actually happened in the batch: red for a deviation that survived to an
 * outcome, green for one a later step caught.
 */
export function LineMap({ s }: { s: ConsoleStore }) {
  const [hover, setHover] = useState<string | null>(null);
  const steps = s.run_config.procedure.steps;
  const per = s.summary?.perStep ?? {};
  const twin = getTwin(s.run_config.procedure.twin);

  const geometry = useMemo(() => {
    const total = steps.reduce((a, b) => a + b.durS, 0) || 1;
    let acc = 0;
    return steps.map((st) => {
      acc += st.durS;
      const frac = acc / total;
      return { step: st, x: PAD_L + frac * (W - PAD_L - PAD_R) };
    });
  }, [steps]);

  const pts = geometry.map((g) => {
    const stat = per[g.step.id] as StepStatDto | undefined;
    return { ...g, y: TERRAIN_TOP + (1 - heat(stat?.p ?? 1e-4)) * TERRAIN_H, stat };
  });

  const area = `M ${pts[0].x} ${TERRAIN_TOP + TERRAIN_H} ` +
    pts.map((q) => `L ${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' ') +
    ` L ${pts[pts.length - 1].x} ${TERRAIN_TOP + TERRAIN_H} Z`;

  const hottest = pts
    .filter((q) => (q.stat?.causalFailure ?? 0) > 0)
    .sort((a, b) => (b.stat?.causalFailure ?? 0) - (a.stat?.causalFailure ?? 0))
    .slice(0, 3);

  const budget = useMemo(() => {
    if (twin.id !== 'tank_transfer') return null;
    const p = twin.params;
    const q = p.qPump / 3600;
    const available = (p.hAh - p.hAl) * p.area / q;
    const toOverflow = (p.hOverflow - p.hAh) * p.area / q;
    const required = p.walkS + p.actS;
    return { available, toOverflow, required, automated: s.cfg.controls.includes('automate_stop') };
  }, [twin, s.cfg.controls]);

  const pickReplay = (stepId: string) => {
    const match = s.traced.find((t) => t.errors.some((e) => e.stepId === stepId)) ?? s.traced[0];
    if (match) void s.loadReplay(match.scn);
  };

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <h2 className="text-[13px] uppercase tracking-[0.2em] text-amber">Line map</h2>
        <p className="text-[12px] text-ash">
          {s.run_config.procedure.id} rev {s.run_config.procedure.revision} - {s.run_config.persona.label} - {s.run_config.plant.label}
        </p>
        {s.summary && (
          <p className="ml-auto text-[12px]">
            <span className="text-ash">failure </span>
            <span className={s.summary.failureRate > 0.02 ? 'text-vermillion' : 'text-phosphor'}>
              {(s.summary.failureRate * 100).toFixed(2)}%
            </span>
            <span className="text-ash"> of {(s.summary.n / 1000).toFixed(1)}k shifts - {eur(s.summary.annualLossEur)} a year</span>
          </p>
        )}
      </div>

      <svg viewBox={`0 0 ${W} 396`} className="w-full" role="img" aria-label="Procedure line map with error terrain">
        <defs>
          <linearGradient id="terrain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff4a2f" stopOpacity="0.42" />
            <stop offset="60%" stopColor="#ffb03a" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#ffb03a" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* probability grid */}
        {[1e-4, 1e-3, 1e-2, 1e-1].map((p) => {
          const y = TERRAIN_TOP + (1 - heat(p)) * TERRAIN_H;
          return (
            <g key={p}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="#232a34" strokeWidth="1" />
              <text x={PAD_L - 8} y={y + 3} textAnchor="end" fontSize="9" fill="#8a95a3">{p.toExponential(0)}</text>
            </g>
          );
        })}
        <text x={PAD_L - 8} y={TERRAIN_TOP - 12} textAnchor="end" fontSize="9" fill="#8a95a3" className="uppercase">p(error)</text>

        <path d={area} fill="url(#terrain)" />

        {/* the route */}
        <line x1={PAD_L} x2={W - PAD_R} y1={LINE_Y} y2={LINE_Y} stroke="#232a34" strokeWidth="2" />
        {pts.map((q, i) => {
          const next = pts[i + 1];
          if (!next) return null;
          const hot = hottest.some((h) => h.step.id === q.step.id);
          return (
            <line key={q.step.id} x1={q.x} y1={LINE_Y} x2={next.x} y2={LINE_Y}
              stroke={hot ? '#ff4a2f' : '#3b4552'} strokeWidth={hot ? 3 : 2} opacity={hot ? 0.9 : 1} />
          );
        })}

        {pts.map((q) => {
          const stat = q.stat;
          const thrown = stat?.thrown ?? 0;
          const escaped = stat?.escaped ?? 0;
          const caught = stat?.caught ?? 0;
          const failShare = s.summary && s.summary.failed > 0 ? (stat?.causalFailure ?? 0) / s.summary.failed : 0;
          const r = 6 + heat(q.step.errors?.length ? stat?.p ?? 1e-4 : 1e-5) * 9;
          const selected = s.selectedStep === q.step.id;
          const isHot = hottest.some((h) => h.step.id === q.step.id);
          return (
            <g key={`st-${q.step.id}`} transform={`translate(${q.x} ${LINE_Y})`}
               onClick={() => s.setSelectedStep(selected ? null : q.step.id)}
               onMouseEnter={() => setHover(q.step.id)} onMouseLeave={() => setHover(null)}
               className="cursor-crosshair">
              {escaped > 0 && (
                <circle r={r + 7} fill="#ff4a2f" opacity={Math.min(0.55, failShare * 1.6 + 0.06)}
                  className={isHot ? 'hazard-pulse' : ''} />
              )}
              <circle r={r} fill={selected ? '#ffb03a' : '#0e1115'} stroke={selected ? '#ffb03a' : '#8a95a3'} strokeWidth={selected ? 2 : 1} />
              {thrown > 0 && caught / thrown > 0 && (
                <path
                  d={arc(r + 3, caught / thrown)}
                  fill="none" stroke="#3ee08f" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
              )}
              {q.step.verify && <rect x={-3} y={-3} width={6} height={6} fill="#4fd8ff" />}
              {q.step.watch && <path d={`M -5 0 L 0 -5 L 5 0 L 0 5 Z`} fill="none" stroke="#4fd8ff" strokeWidth="1.4" />}
              {q.step.emergency && <path d="M 0 -8 L 8 6 L -8 6 Z" fill="none" stroke="#a37bff" strokeWidth="1.4" />}
              <text y={r + 20} textAnchor="middle" fontSize="9" fill={hover === q.step.id || selected ? '#e8e4dc' : '#8a95a3'}>
                {q.step.id}
              </text>
              {hover === q.step.id && (
                <text y={r + 32} textAnchor="middle" fontSize="9" fill="#ffb03a">
                  {thrown ? `${escaped} escaped / ${thrown} thrown` : 'no error surface'}
                </text>
              )}
            </g>
          );
        })}

        {/* response budget, the thing nobody computes */}
        {budget && (
          <g transform={`translate(${PAD_L} ${BUDGET_Y})`}>
            <text x="0" y="-8" fontSize="9" fill="#8a95a3" className="uppercase">
              time the tank gives the operator between the alarm and the independent trip
            </text>
            <rect x="0" y="4" width={budget.available * 3.1} height="12" fill="#4fd8ff" opacity="0.24" />
            <rect x="0" y="4" width={budget.available * 3.1} height="12" fill="none" stroke="#4fd8ff" strokeDasharray="2 3" />
            <rect x="0" y="22" width={budget.required * 3.1} height="12" fill={budget.required > budget.available ? '#ff4a2f' : '#3ee08f'} opacity="0.6" />
            <text x={budget.available * 3.1 + 6} y="14" fontSize="10" fill="#4fd8ff">{budget.available.toFixed(0)} s available</text>
            <text x={budget.required * 3.1 + 6} y="32" fontSize="10" fill={budget.required > budget.available ? '#ff4a2f' : '#3ee08f'}>
              {budget.required} s to walk to the pump and stop it
            </text>
            {budget.automated && (
              <text x="0" y="52" fontSize="10" fill="#3ee08f">
                automated stop fitted: the human no longer stands in this gap; residual risk is fail-on-demand 0.01
              </text>
            )}
            {!budget.automated && budget.required > budget.available && (
              <text x="0" y="52" fontSize="10" fill="#ff4a2f">
                the procedure depends on a human action that does not fit inside the window
              </text>
            )}
          </g>
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] uppercase tracking-[0.14em] text-ash">
        <Legend colour="#ff4a2f" label="deviation survived to an outcome" />
        <Legend colour="#3ee08f" label="caught by a later step" ring />
        <Legend colour="#4fd8ff" label="check / monitoring action" />
        <Legend colour="#a37bff" label="emergency instruction" />
        {hottest.length > 0 && (
          <span className="ml-auto flex items-center gap-2">
            worst: <button onClick={() => pickReplay(hottest[0].step.id)} className="text-vermillion underline">
              replay a shift that broke at {hottest[0].step.id}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function arc(r: number, frac: number): string {
  const a = Math.min(1, frac) * Math.PI * 2;
  const x = r * Math.sin(a);
  const y = -r * Math.cos(a);
  const large = a > Math.PI ? 1 : 0;
  return `M 0 ${-r} A ${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

function Legend({ colour, label, ring }: { colour: string; label: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full"
        style={ring ? { border: `2px solid ${colour}` } : { background: colour, opacity: 0.7 }} />
      {label}
    </span>
  );
}
