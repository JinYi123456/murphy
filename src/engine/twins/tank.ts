import type { TwinConfig, TwinDef, TwinParams } from './twin';

/**
 * TWIN: road tanker to storage tank transfer on an inland bulk terminal.
 *
 * Flagship asset, chosen because its physics is mass balance, pump hydraulics
 * and vapour-space pressure - simple enough to state honestly on one screen,
 * and severe enough that a single lineup or monitoring error produces a real
 * release. Protection layers follow the API RP 2350 pattern: operational
 * transfer control, high level alarm, an independent high-high function, and
 * secondary containment.
 *
 * Continuous state:
 *   0 level        m    liquid height in TK-101
 *   1 lineP        bar  pump discharge pressure
 *   2 stress       s    time the line has spent above its sustained rating
 *   3 spill        m3   total released from any source
 *   4 bund         m3   currently held by secondary containment
 *   5 escaped      m3   released beyond containment
 *   6 diverted     m3   delivered somewhere other than TK-101
 *   7 pumpTime     s    pump running time
 *   8 t            s    elapsed process time
 *   9 delivered    m3   volume actually received by TK-101
 *  10 peakLineP    bar
 *  11 tankP        mbar gauge pressure in the vapour space
 *  12 lahLatched   0/1  high level alarm has announced
 *  13 ahLatched    0/1  level has reached the high-high set point
 *  14 lineFailed   0/1
 *  15 overflowed   0/1
 *  16 roofFailed   0/1  over-pressure failure of the roof seam
 *  17 secsSinceAl  s    time since the alarm announced, -1 before it does
 *  18 oneShotDone  0/1  latch so a single field action releases once
 *
 * Scenario state:
 *   0 V1 inlet valve              1 = open
 *   1 V2 tank draw-off valve      1 = open (must be closed for a transfer)
 *   2 V3 cross-connect to TK-102  1 = open (must be closed)
 *   3 V4 vent / vapour balance    1 = open
 *   4 PUMP
 *   5 LAH  soft high level alarm in service
 *   6 PIS  independent high-high switch in service
 *   7 RACK vehicle bonded, hose made up correctly
 *   8 STOP transfer stopped
 *   9 PISFAIL present but fails on demand
 *  10 gaugeBias m  error on the local level indicator
 *  11 flowScale   actual pump flow relative to rating
 */

const VARS = [
  'level', 'lineP', 'stress', 'spill', 'bund', 'escaped', 'diverted', 'pumpTime', 't',
  'delivered', 'peakLineP', 'tankP', 'lahLatched', 'ahLatched', 'lineFailed', 'overflowed',
  'roofFailed', 'secsSinceAl', 'oneShotDone',
];
const DISCS = [
  'V1', 'V2', 'V3', 'V4', 'PUMP', 'LAH', 'PIS', 'RACK', 'STOP', 'PISFAIL', 'gaugeBias', 'flowScale',
  'V3LEAK', 'BUND_HEADROOM', 'BOND_OK', 'HAMMER', 'HOSE_SPILL',
];

const P: TwinParams = {
  area: 12.6,
  hOverflow: 10.0,
  hAl: 9.3,
  hAh: 9.6,
  qPump: 110,
  qOut: 90,
  crossFrac: 0.6,
  pDead: 82,
  pRun: 7.5,
  tauP: 8,
  pRating: 25,
  stressFail: 40,
  burstM3: 7,
  leakQ: 45,
  bundCap: 55,
  batchM3: 55,
  pRoof: 45,
  tauVent: 4,
  roofBurstM3: 14,
  progressRate: 110 / 3600,
  /** internal leak through a cross-connect that is not seated, m3/h */
  weepQ: 12,
  /** release when the line is hammered at shutdown, m3 */
  hammerM3: 0.5,
  /** release when a coupling is broken before the hose has drained, m3 */
  hoseM3: 0.3,
  /** seconds for the operator to walk from the level gauge to the pump handle */
  walkS: 55,
  /** seconds to close the valve and stop the pump once there */
  actS: 20,
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const tankTwin: TwinDef = {
  id: 'tank_transfer',
  label: 'Tanker to TK-101 transfer',
  unit: 'Inland bulk terminal, rack 3',
  hazardKind: 'flammable liquid release',
  vars: VARS,
  discs: DISCS,
  params: P,
  iface: {
    progress: 'delivered',
    target: 'batchM3',
    rate: 'progressRate',
    runFlag: 'PUMP',
    stopFlag: 'STOP',
    alarm: 'lahLatched',
    hazard: 'spill',
    clock: 't',
    bias: 'gaugeBias',
    scale: 'flowScale',
    failOnDemand: 'PISFAIL',
  },
  display: {
    level: { label: 'TK-101 level', unit: 'm', danger: 10.0 },
    lineP: { label: 'Pump discharge', unit: 'bar', danger: 25 },
    tankP: { label: 'Vapour space', unit: 'mbar', danger: 45 },
    spill: { label: 'Released', unit: 'm3', danger: 0.05 },
    delivered: { label: 'Received by TK-101', unit: 'm3' },
  },

  varIndex(n) { return VARS.indexOf(n); },
  discIndex(n) { return DISCS.indexOf(n); },

  init(s, o, d, k, p, cfg: TwinConfig) {
    s[o + 0] = p.hOverflow * cfg.startLevelFrac;
    for (let i = 1; i < 12; i++) s[o + i] = 0;
    s[o + 12] = 0; s[o + 13] = 0; s[o + 14] = 0; s[o + 15] = 0; s[o + 16] = 0;
    s[o + 17] = -1;

    d[k + 0] = 0; d[k + 1] = 0; d[k + 2] = 0; d[k + 3] = 1; d[k + 4] = 0;
    d[k + 5] = cfg.preIsolated.includes('LAH') ? 0 : 1;
    d[k + 6] = cfg.preIsolated.includes('PIS') ? 0 : 1;
    d[k + 7] = 1;
    d[k + 8] = 0;
    d[k + 9] = 0;
    d[k + 10] = cfg.indicatorBias;
    d[k + 11] = 1;
    // scenario flags that a step can spoil
    d[k + 12] = 0; // V3LEAK: cross-connect not seated, feeds the tank from the header
    d[k + 13] = 1; // BUND_HEADROOM: fraction of the bund still available
    d[k + 14] = 1; // BOND_OK: vehicle earthed
    d[k + 15] = 0; // HAMMER: line hammered at shutdown, weeping couplings
    d[k + 16] = 0; // HOSE_SPILL: coupling broken before the line drained
    s[o + 18] = 0;
    if (cfg.preIsolated.includes('V4')) d[k + 3] = 0;
    if (cfg.protection['pis'] === false) d[k + 6] = 0;
    if (cfg.protection['lah'] === false) d[k + 5] = 0;
  },

  advance(s, o, d, k, p, dt) {
    const pump = d[k + 4] * (1 - d[k + 8]);
    const v1 = d[k + 0]; const v2 = d[k + 1]; const v3 = d[k + 2]; const v4 = d[k + 3];
    const q = pump * (p.qPump / 3600) * d[k + 11];

    const toTank = q * v1 * (1 - p.crossFrac * v3);
    const toCross = q * v1 * p.crossFrac * v3;
    const outOf = v2 * (p.qOut / 3600) * (s[o + 0] > 0.05 ? 1 : 0);
    const deadhead = pump * (1 - v1);

    // mass balance
    // a cross-connect that is off its seat keeps feeding the tank from the
    // common header even after the pump is stopped - the mechanism that turns a
    // correct shutdown into an overfill
    const weep = d[k + 12] * (p.weepQ / 3600);
    let lvl = s[o + 0] + ((toTank + weep - outOf) / p.area) * dt;
    lvl = lvl < 0 ? 0 : lvl;
    s[o + 0] = lvl;
    s[o + 6] = s[o + 6] + (toCross + outOf) * dt;

    // pump discharge pressure
    const target = pump === 0 ? 0 : deadhead === 1 ? p.pDead : p.pRun;
    s[o + 1] = s[o + 1] + (target - s[o + 1]) * clamp(dt / p.tauP, 0, 1);
    if (s[o + 1] > s[o + 10]) s[o + 10] = s[o + 1];

    // line stress then failure
    s[o + 2] = s[o + 2] + (s[o + 1] > p.pRating ? dt : 0);
    if (s[o + 2] > p.stressFail && s[o + 14] === 0) {
      s[o + 14] = 1;
      s[o + 3] = s[o + 3] + p.burstM3;
      s[o + 1] = 4;
    }
    const leak = s[o + 14] * pump * (p.leakQ / 3600) * dt;

    // vapour space pressure: the quiet killer when the vent line is shut
    const space = clamp((p.hOverflow - lvl) * p.area, 0.5, 1e6);
    const compress = v4 === 0 && toTank > 0 ? (toTank / space) * p.pRoof * dt : 0;
    const ventRelief = (0 - s[o + 11]) * clamp(dt / p.tauVent, 0, 1);
    s[o + 11] = s[o + 11] + (v4 === 0 ? compress : ventRelief);
    if (s[o + 11] > p.pRoof && s[o + 16] === 0) {
      s[o + 16] = 1;
      s[o + 3] = s[o + 3] + p.roofBurstM3;
      s[o + 11] = 0;
    }
    const roofLeak = s[o + 16] * toTank * dt;

    // overflow
    const above = s[o + 0] > p.hOverflow ? 1 : 0;
    if (above === 1) s[o + 15] = 1;
    const overSpill = above * toTank * dt;

    // one-shot releases tied to a specific field action
    const oneShot = s[o + 18] === 0 && (d[k + 15] + d[k + 16]) > 0
      ? (d[k + 15] === 1 ? p.hammerM3 : 0) + (d[k + 16] === 1 ? p.hoseM3 : 0)
      : 0;
    if (oneShot > 0) s[o + 18] = 1;

    s[o + 3] = s[o + 3] + leak + roofLeak + overSpill + oneShot;
    s[o + 9] = s[o + 9] + toTank * dt;
    s[o + 7] = s[o + 7] + pump * dt;
    s[o + 8] = s[o + 8] + dt;

    // secondary containment
    const want = leak + roofLeak + overSpill + oneShot;
    const capacity = p.bundCap * (d[k + 13] > 0 ? d[k + 13] : 1);
    const room = capacity - s[o + 4];
    const retained = want < room ? want : room;
    s[o + 4] = s[o + 4] + retained;
    s[o + 5] = s[o + 5] + (want - retained);

    // protection function demands
    if (s[o + 0] >= p.hAl && d[k + 5] === 1 && s[o + 12] === 0) {
      s[o + 12] = 1;
      s[o + 17] = 0;
    }
    if (s[o + 12] === 1 && s[o + 17] >= 0) s[o + 17] = s[o + 17] + dt;

    if (s[o + 0] >= p.hAh && s[o + 13] === 0) {
      s[o + 13] = 1;
      const acts = d[k + 6] * (1 - d[k + 9]);
      if (acts === 1) d[k + 8] = 1;
    }
  },

  indication(s, o, d, k, name) {
    if (name === 'level') return s[o + 0] + d[k + 10];
    return s[o + tankTwin.varIndex(name)];
  },

  magnitudes(s, o, d, k) {
    const p = P;
    return {
      releaseM3: s[o + 3],
      containedM3: s[o + 4],
      escapedM3: s[o + 5],
      divertedM3: s[o + 6],
      deliveredM3: s[o + 9],
      peakLineBar: s[o + 10],
      peakTankMbar: s[o + 11],
      pumpRunMin: s[o + 7] / 60,
      shiftMin: s[o + 8] / 60,
      alarmLeadS: s[o + 17],
      roofFailed: s[o + 16],
      lineFailed: s[o + 14],
      overflowed: s[o + 15],
      pisDemand: s[o + 13],
      batchShortfallM3: Math.max(0, P.batchM3 - s[o + 9]),
      bondOk: d[k + 14],
      weepM3h: d[k + 12] > 0 ? p.weepQ : 0,
      bundCapacityM3: p.bundCap * (d[k + 13] > 0 ? d[k + 13] : 1),
      /**
       * Response budgets in the vocabulary of the overfill-protection guidance:
       * how long the tank gives the operator between the alarm and the
       * high-high trip, and between the trip and the overflow, against how long
       * it actually takes a person to walk to the pump and stop it.
       */
      rt2AvailableS: (p.hAh - p.hAl) * p.area / (p.qPump / 3600),
      rt3AvailableS: (p.hOverflow - p.hAh) * p.area / (p.qPump / 3600),
      responseRequiredS: p.walkS + p.actS,
    };
  },

  classify(s, o, d, k, p) {
    if (s[o + 16] === 1) return 'tank_breach';
    if (s[o + 14] === 1) return 'line_failure';
    if (s[o + 15] === 1) return 'overfill';
    if (s[o + 5] > 0.05) return 'containment_escape';
    if (s[o + 6] > p.batchM3 * 0.2) return 'misrouting';
    if (s[o + 3] > 0.05) return 'minor_release';
    if (d[k + 8] === 1 && s[o + 13] === 1 && s[o + 9] < p.batchM3 * 0.95) return 'trip_stop';
    if (s[o + 9] < p.batchM3 * 0.5) return 'no_flow';
    if (s[o + 9] < p.batchM3 * 0.9) return 'short_batch';
    return 'normal';
  },

  hazardNote(s, o, _d, _k, p) {
    if (s[o + 16] === 1) return `Roof seam failed at ${p.pRoof} mbar - the tank lost containment`;
    if (s[o + 14] === 1) return `Hose or gasket blew at ${s[o + 10].toFixed(0)} bar discharge - ${s[o + 3].toFixed(1)} m3 on the rack deck`;
    if (s[o + 15] === 1) return `Overflow over the TK-101 roof above ${p.hOverflow.toFixed(1)} m - ${s[o + 3].toFixed(1)} m3 released`;
    if (s[o + 5] > 0.05) return `${s[o + 5].toFixed(1)} m3 left the bund to the surface drainage`;
    if (s[o + 6] > 1) return `${s[o + 6].toFixed(1)} m3 went to TK-102 or the manifold instead of TK-101`;
    if (s[o + 3] > 0.05) return `${s[o + 3].toFixed(2)} m3 released and held by the bund`;
    return '';
  },
};
