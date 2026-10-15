import type { TwinConfig, TwinDef, TwinParams } from './twin';

/**
 * TWIN: reheat furnace light-off after a refractory repair.
 *
 * The second asset class exists to prove the kernel is not a tank simulator
 * with a chat window. Nothing about the procedure model, the reliability
 * tables or the statistics changes: only this file does. Here the dangerous
 * quantities are unburnt fuel gas in the furnace atmosphere and the rate at
 * which water is driven out of a fresh lining. Both are consequences of
 * schedule pressure, which is exactly the mechanism that makes light-off
 * procedures fail in practice.
 *
 * Continuous state:
 *   0 zoneT      C     process zone temperature
 *   1 shellT     C     outer shell temperature, the visible sign of lining loss
 *   2 gasAccum   m3    unburnt fuel gas standing in the furnace
 *   3 moisture   %     water still in the refractory
 *   4 damage     0..1  spalling / structural loss of the lining
 *   5 t          s     elapsed
 *   6 fuel       m3    gas burned
 *   7 peakZone   C
 *   8 peakShell  C
 *   9 alarm      0/1   shell hot spot annunciator latched
 *  10 sinceAl    s     time since that alarm, -1 before
 *  11 hazardMJ   MJ    energy of anything that has actually gone wrong
 *  12 deflagrated 0/1
 *  13 liningFailed 0/1
 *  14 purgeS     s     cumulative clean-air flow time
 *  15 cmdT       C     the setpoint the operator has commanded
 *  16 rampCmd    C/h   the ramp rate the operator has commanded
 *
 * Scenario state:
 *   0 FAN combustion air fan running
 *   1 DAMPER open to atmosphere
 *   2 PILOT pilot burner lit
 *   3 MAINGAS main gas valve open
 *   4 GASLEAK  main valve passes while closed
 *   5 BMS      burner management shutdown function in service
 *   6 BMSFAIL  in service but fails on demand
 *   7 STOP     shutdown asserted
 *   8 tcBias C  error on the zone thermocouple
 *   9 scale     burner capacity factor
 *  10 leakM3s   m3/s of unburnt gas when the valve leaks or is opened cold
 */

const VARS = [
  'zoneT', 'shellT', 'gasAccum', 'moisture', 'damage', 't', 'fuel', 'peakZone', 'peakShell',
  'alarm', 'sinceAl', 'hazardMJ', 'deflagrated', 'liningFailed', 'purgeS', 'cmdT', 'rampCmd',
];
const DISCS = ['FAN', 'DAMPER', 'PILOT', 'MAINGAS', 'GASLEAK', 'BMS', 'BMSFAIL', 'STOP', 'tcBias', 'scale', 'leakM3s', 'purgeFrac'];

const P: TwinParams = {
  tAmbient: 25,
  tOperating: 1150,
  /** ramp limit while the lining still holds water, C/h */
  rampWet: 60,
  /** ramp limit once dry, C/h */
  rampDry: 150,
  /** moisture below which the lining is considered dry, % */
  moistureDry: 1.0,
  /** cure start temperature, C */
  cureTop: 300,
  tauZone: 240,
  tauShell: 2400,
  /** shell temperature as a fraction of zone temperature, sound lining */
  shellFrac: 0.19,
  shellAlarm: 260,
  shellFail: 340,
  /** unburnt gas inventory at which re-ignition becomes a deflagration, m3 */
  lflM3: 6,
  /** energy released by a deflagration of that inventory, MJ per m3 */
  mjPerM3: 36,
  /** purge clearance rate of furnace atmosphere, m3/s while the fan runs */
  purgeRate: 0.055,
  /** gas burned per second at nominal firing */
  burnRate: 0.42,
  /** damage rate coefficient for over-ramping, per second per unit excess */
  damageK: 0.00022,
  /** drying coefficient, % per second at full drive-out */
  dryK: 0.0009,
  /** gas admitted to a chamber with no flame in it, m3/s - a full burner train */
  admitM3s: 0.05,
  progressRate: 60 / 3600,
  /** nominal purge time the procedure requires, s */
  purgeRequired: 900,
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const furnaceTwin: TwinDef = {
  id: 'furnace_lightoff',
  label: 'Reheat furnace light-off after lining repair',
  unit: 'Heat treatment shop, furnace 4',
  hazardKind: 'fuel gas deflagration and lining failure',
  vars: VARS,
  discs: DISCS,
  params: P,
  iface: {
    progress: 'zoneT',
    target: 'tOperating',
    rate: 'progressRate',
    runFlag: 'MAINGAS',
    stopFlag: 'STOP',
    alarm: 'alarm',
    hazard: 'hazardMJ',
    clock: 't',
    runoutFactor: 1.02,
    bias: 'tcBias',
    scale: 'scale',
    failOnDemand: 'BMSFAIL',
    tickS: 60,
  },
  display: {
    zoneT: { label: 'Zone temperature', unit: 'C', danger: 1200 },
    shellT: { label: 'Shell temperature', unit: 'C', danger: 260 },
    gasAccum: { label: 'Unburnt gas in furnace', unit: 'm3', danger: 6 },
    moisture: { label: 'Lining moisture', unit: '%' },
    damage: { label: 'Lining damage', unit: 'index', danger: 1 },
  },

  varIndex(n) { return VARS.indexOf(n); },
  discIndex(n) { return DISCS.indexOf(n); },

  init(s, o, d, k, p, cfg: TwinConfig) {
    s[o + 0] = p.tAmbient + (p.cureTop - p.tAmbient) * cfg.startLevelFrac * 0.2;
    s[o + 1] = p.tAmbient + 8;
    s[o + 2] = 0;
    s[o + 3] = 4 * (cfg.extra?.moistureStart ?? 1);
    s[o + 4] = 0; s[o + 5] = 0; s[o + 6] = 0; s[o + 7] = s[o + 0]; s[o + 8] = s[o + 1];
    s[o + 9] = 0; s[o + 10] = -1; s[o + 11] = 0; s[o + 12] = 0; s[o + 13] = 0;
    s[o + 14] = 0;
    s[o + 15] = p.tAmbient;
    s[o + 16] = p.rampDry;

    d[k + 0] = 0; d[k + 1] = 0; d[k + 2] = 0; d[k + 3] = 0;
    d[k + 4] = cfg.preIsolated.includes('GASLEAK') ? 1 : 0;
    d[k + 5] = cfg.preIsolated.includes('BMS') ? 0 : 1;
    d[k + 6] = 0;
    d[k + 7] = 0;
    d[k + 8] = cfg.indicatorBias;
    d[k + 9] = 1;
    // a valve that passes while shut leaks litres per minute, not a burner train
    d[k + 10] = cfg.preIsolated.includes('GASLEAK') ? (cfg.extra?.leakM3s ?? 0.0015) : 0;
    // fraction of the required purge the crew actually stands there for
    d[k + 11] = 1;
  },

  advance(s, o, d, k, p, dt) {
    const stop = d[k + 7];
    const fan = d[k + 0] * (1 - stop);
    const pilot = d[k + 2] * (1 - stop);
    const gas = d[k + 3] * (1 - stop);
    const damper = d[k + 1];

    // unburnt gas: admitted but not burning - no flame, or no combustion air -
    // plus whatever a gas valve that is shut is still passing
    const burning = gas * pilot * fan;
    const unburntFlow = gas * (1 - burning) * p.admitM3s + d[k + 4] * (1 - gas) * d[k + 10];
    s[o + 2] = s[o + 2] + unburntFlow * dt;
    if (fan === 1 && damper === 1) {
      const removed = p.purgeRate * dt * d[k + 11] * (gas === 0 ? 1 : 0.2);
      s[o + 2] = s[o + 2] - removed;
      if (s[o + 2] < 0) s[o + 2] = 0;
      s[o + 14] = s[o + 14] + dt;
    }

    // deflagration: an ignition source meets the accumulated inventory
    const ignitionSource = pilot + (s[o + 0] > 500 ? 1 : 0);
    const canExplode = ignitionSource > 0 && s[o + 2] > p.lflM3 && s[o + 12] === 0;
    if (canExplode) {
      s[o + 12] = 1;
      const energy = s[o + 2] * p.mjPerM3;
      s[o + 11] = s[o + 11] + energy;
      s[o + 0] = s[o + 0] + 260;
      s[o + 1] = s[o + 1] + 150;
      s[o + 4] = s[o + 4] + 0.55;
      s[o + 2] = 0;
      d[k + 7] = 1;
    }

    // firing: the lining follows the commanded ramp through a first-order lag
    const firing = gas * pilot * fan;
    if (firing === 1) {
      s[o + 15] = Math.min(p.tOperating, s[o + 15] + (s[o + 16] / 3600) * dt);
      const approach = (s[o + 15] - s[o + 0]) * clamp(dt / p.tauZone, 0, 1);
      s[o + 0] = s[o + 0] + approach;
      const burned = Math.min(s[o + 2], p.burnRate * dt);
      s[o + 2] = s[o + 2] - burned;
      s[o + 6] = s[o + 6] + (p.burnRate * dt);
    } else {
      s[o + 0] = s[o + 0] + (p.tAmbient - s[o + 0]) * clamp(dt / (p.tauZone * 6), 0, 1);
    }

    // drive-out of the lining water
    const drive = s[o + 0] > 100 ? clamp((s[o + 0] - 100) / 200, 0, 1) : 0;
    s[o + 3] = s[o + 3] - drive * p.dryK * dt * (s[o + 3] > 0 ? 1 : 0);
    if (s[o + 3] < 0) s[o + 3] = 0;

    // over-ramping a wet lining spalls it
    const limit = s[o + 3] > p.moistureDry && s[o + 0] < p.cureTop ? p.rampWet : p.rampDry;
    const rampActual = s[o + 16];
    const excess = rampActual > limit ? (rampActual - limit) / limit : 0;
    if (excess > 0 && s[o + 3] > p.moistureDry * 0.5 && firing === 1) {
      s[o + 4] = Math.min(1.5, s[o + 4] + excess * p.damageK * dt);
    }
    if (s[o + 4] >= 1 && s[o + 13] === 0) {
      s[o + 13] = 1;
      s[o + 11] = s[o + 11] + 30;
    }

    // shell temperature: the visible sign of what happened inside
    const insulLoss = s[o + 4] * 0.35;
    const shellTarget = p.tAmbient + s[o + 0] * (p.shellFrac + insulLoss);
    s[o + 1] = s[o + 1] + (shellTarget - s[o + 1]) * clamp(dt / p.tauShell, 0, 1);
    if (s[o + 0] > s[o + 7]) s[o + 7] = s[o + 0];
    if (s[o + 1] > s[o + 8]) s[o + 8] = s[o + 1];

    if (s[o + 1] >= p.shellAlarm && s[o + 9] === 0) {
      s[o + 9] = 1;
      s[o + 10] = 0;
    }
    if (s[o + 9] === 1 && s[o + 10] >= 0) s[o + 10] = s[o + 10] + dt;

    // burner management shutdown on high shell, independent of the operator
    if (s[o + 1] >= p.shellFail && s[o + 9] === 1) {
      const acts = d[k + 5] * (1 - d[k + 6]);
      if (acts === 1) d[k + 7] = 1;
    }

    s[o + 5] = s[o + 5] + dt;
  },

  indication(s, o, d, k, name) {
    if (name === 'zoneT') return s[o + 0] + d[k + 8];
    const i = furnaceTwin.varIndex(name);
    return i >= 0 ? s[o + i] : 0;
  },

  magnitudes(s, o) {
    return {
      hazardMJ: s[o + 11],
      damage: s[o + 4],
      deflagrated: s[o + 12],
      liningFailed: s[o + 13],
      peakZoneC: s[o + 7],
      peakShellC: s[o + 8],
      gasPurgedS: s[o + 14],
      residualGasM3: s[o + 2],
      fuelM3: s[o + 6],
      shiftMin: s[o + 5] / 60,
      alarmLeadS: s[o + 10],
      moistureLeftPct: s[o + 3],
      heatShortfallC: Math.max(0, P.tOperating - s[o + 0]),
      releaseM3: 0,
    };
  },

  classify(s, o, d, k, p) {
    if (s[o + 12] === 1) return 'deflagration';
    if (s[o + 13] === 1) return 'refractory_damage';
    if (s[o + 8] >= p.shellFail) return 'shell_hotspot';
    if (s[o + 4] > 0.15) return 'hot_start';
    if (d[k + 7] === 1) return 'trip_stop';
    if (s[o + 0] < p.tOperating * 0.85) return 'no_light_off';
    return 'normal';
  },

  hazardNote(s, o, _d, _k, p) {
    if (s[o + 12] === 1) return `Deflagration - ${s[o + 11].toFixed(0)} MJ released inside the furnace`;
    if (s[o + 13] === 1) return `Lining failed - spalled to the anchors, shell reached ${s[o + 8].toFixed(0)} C`;
    if (s[o + 8] >= p.shellAlarm) return `Shell hot spot at ${s[o + 8].toFixed(0)} C over the repaired roof`;
    if (s[o + 4] > 0.15) return `Lining damaged by ramping at ${s[o + 16].toFixed(0)} C/h with ${s[o + 3].toFixed(1)}% moisture still in it`;
    if (s[o + 0] < p.tOperating * 0.85) return `Heat-up incomplete - zone at ${s[o + 0].toFixed(0)} C after ${s[o + 5].toFixed(0)} s`;
    return '';
  },
};
