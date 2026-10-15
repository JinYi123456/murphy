import type { TwinConfig, TwinDef, TwinParams } from './twin';

/**
 * TWIN: reheat furnace 4 in production - slab heat-up ahead of the rolling mill.
 *
 * The light-off twin answers "can we safely put fire in this furnace?". This one
 * answers the question an operating crew actually fails: "we are already at
 * temperature, the mill is waiting, and the grade needs the slab ten degrees
 * hotter - can the setpoints be moved without ruining the metal?" Nothing here
 * involves a purge or a wet lining. The hazardous quantities are slab
 * temperature against a rolling window, furnace pressure at the roof, unburnt
 * gas after a flame-out, and the rate at which a crew is allowed to move the
 * controls. All four are consequences of schedule pressure.
 *
 * Two deliberate modelling decisions, because the kernel must stay tensor-safe:
 *
 *  1. The charge is a continuum. A real furnace holds dozens of slabs and the
 *     reference implementation keeps a list of them; a list cannot be stepped
 *     one hundred thousand times in parallel, so one tracked element carries the
 *     thermal history of the charge and the discharge stream is judged
 *     continuously against the rolling window instead of slab by slab. Mass is
 *     therefore conserved exactly: every gram that leaves is booked to good,
 *     scrap or burn-off, and the sum equals the metered charge.
 *  2. The furnace does not know where one procedure step ends and the next
 *     begins, so the rate-of-change guardrails have to be *detected* rather than
 *     declared. The controller holds its own memory of the last setpoint it
 *     accepted; a difference between a command and that memory is a movement, two
 *     differences in one integration interval are two levers at once, and a
 *     movement landing while the chamber is still chasing the previous command is
 *     an un-settled movement. The punishment is then physics and not a rulebook:
 *     the loop winds up, the achieved temperature overshoots the command, and the
 *     slab window is missed.
 *
 * Continuous state:
 *   0 preT       C     preheat zone temperature
 *   1 soak1T     C     soak-1 zone temperature
 *   2 soak2T     C     soak-2 zone temperature
 *   3 dischT     C     discharge zone temperature at the mouth
 *   4 cmdPre     C     commanded preheat setpoint      (lever)
 *   5 cmdSoak1   C     commanded soak-1 setpoint       (lever)
 *   6 cmdSoak2   C     commanded soak-2 setpoint       (lever)
 *   7 cmdSpeed   sl/h  commanded hearth speed          (lever)
 *   8 cmdTrim    %     fuel trim to the fired zone     (lever)
 *   9 cmdAir     -     air trim, excess-air multiplier (lever)
 *  10 lineSpeed  sl/h  actual hearth speed
 *  11 fuelDem    %     firing demand against nominal
 *  12 o2         %     flue gas oxygen, dry
 *  13 press      mbar  furnace pressure at the roof
 *  14 slabProg   0..1  position of the tracked charge element
 *  15 slabT      C     temperature of the tracked element
 *  16 exitT      C     temperature of the metal leaving the mouth
 *  17 chargeT    C     charge entry temperature
 *  18 peakSlabT  C     hottest slab temperature reached
 *  19 goodT      t     in-spec tonnes delivered to the mill  (progress)
 *  20 scrapT     t     tonnes scrapped, cold plus hot
 *  21 burnT      t     tonnes lost as scale and burn-off
 *  22 meterT     t     tonnes charged; goodT + scrapT + burnT
 *  23 gj         GJ    gas energy burned
 *  24 shellT     C     shell temperature at the worst survey point
 *  25 refr       idx   refractory damage index
 *  26 t          s     elapsed process time
 *  27 sinceMove  s     time since the last commanded movement
 *  28 windUp     C     un-settled command error from oversized or early moves
 *  29 conflict   0..1  control conflict from simultaneous movements
 *  30 hazardT    t     metal actually lost beyond the quality allowance
 *  31 hiAl       0/1   high temperature annunciator latched
 *  32 sinceAl    s     time since it announced, -1 before
 *  33 tripped    0/1   burner management shutdown demanded
 *  34 flameOut   0/1   combustion lifted off the burners
 *  35 refFail    0/1   refractory over-temperature failure
 *  36 pressPeak  mbar
 *  37 devAcc     C.s   integral of the exit temperature deviation
 *  38 holdT      s     time fired with no metal moving
 *  39 gasAcc     m3    unburnt gas standing in the chamber
 *  40 lockPre      C   the setpoint the controller last accepted
 *  41 lockSoak1    C
 *  42 lockSoak2    C
 *  43 lockSpeed    sl/h
 *  44 lockTrim     %
 *  45 lockAir      -
 *  46 maxMove      C   largest single movement of a temperature setpoint seen
 *  47 badRatio     0..1 heat added while the air/fuel ratio was already wrong
 *  48 popped       0/1  deflagration of the accumulated gas
 *  49 hotScrapT    t    tonnes scrapped over-temperature
 *  50 coldScrapT   t    tonnes scrapped under-temperature
 *  51 twoMoves     n    count of movements that took two levers at once
 *
 * Scenario state:
 *   0 BURN       main firing permitted
 *   1 FAN        combustion air fan running
 *   2 IDF        induced draft fan pulling the flue gas
 *   3 PUSH       charge pusher in automatic
 *   4 MIX        hearth and roof cooling water pump running
 *   5 MILL       the rolling mill is taking slab
 *   6 STOP       shutdown asserted
 *   7 ALARM      high slab temperature alarm in service
 *   8 TRIP       burner management and pressure protection in service
 *   9 TRIPFAIL   in service but fails on demand
 *  10 tcBias     C  error on the discharge pyrometer
 *  11 scale      burner capacity factor
 *  12 burnClog   0..1 aggregate burner clogging across the zones
 *  13 damperStuck 0/1 flue damper stuck closed
 *  14 coldBatch  0/1 cold slab batch charged from the yard
 *  15 zBias      C  error on the replaced soak-1 thermocouple
 *  16 GASLEAK    0/1 a burner train passes gas while shut
 *  17 HARDTRIP   0/1 hard-wired independent shutdown the procedure cannot leave isolated
 */

const VARS = [
  'preT', 'soak1T', 'soak2T', 'dischT',
  'cmdPre', 'cmdSoak1', 'cmdSoak2', 'cmdSpeed', 'cmdTrim', 'cmdAir',
  'lineSpeed', 'fuelDem', 'o2', 'press',
  'slabProg', 'slabT', 'exitT', 'chargeT', 'peakSlabT',
  'goodT', 'scrapT', 'burnT', 'meterT', 'gj',
  'shellT', 'refr', 't', 'sinceMove', 'windUp', 'conflict', 'hazardT',
  'hiAl', 'sinceAl', 'tripped', 'flameOut', 'refFail', 'pressPeak',
  'devAcc', 'holdT', 'gasAcc',
  'lockPre', 'lockSoak1', 'lockSoak2', 'lockSpeed', 'lockTrim', 'lockAir',
  'maxMove', 'badRatio', 'popped', 'hotScrapT', 'coldScrapT', 'twoMoves',
];

const DISCS = [
  'BURN', 'FAN', 'IDF', 'PUSH', 'MIX', 'MILL', 'STOP', 'ALARM', 'TRIP', 'TRIPFAIL',
  'tcBias', 'scale', 'burnClog', 'damperStuck', 'coldBatch', 'zBias', 'GASLEAK', 'HARDTRIP',
];

const P: TwinParams = {
  tAmbient: 30,
  /** rolling window the mill specifies at the discharge table */
  tCold: 1150,
  tCentre: 1218,
  tHot: 1278,
  /** high slab temperature annunciator, just above the top of the rolling window */
  tAlarm: 1285,
  /**
   * A group of slabs arriving at the mouth has a temperature spread, so a furnace
   * that is five degrees off the bottom of the window rejects some of the group,
   * not all of it. Without these bands a marginal furnace loses its entire hourly
   * output and the difference between a small slip and a large one disappears.
   */
  coldBand: 40,
  hotBand: 45,

  /** slab mass and furnace inventory */
  slabMass: 3.2,
  positions: 24,
  inFurnaceT: 76.8,
  speedNom: 24,
  chargeCap: 44,
  /** charge entry temperature: hot direct from the caster, cold from the yard */
  chargeHot: 420,
  chargeCold: 140,
  /**
   * A cold batch does not clear the furnace when the crew notices it: the slab
   * that is already between the charge face and the mouth has to be walked
   * through, so the disturbance outlives the correction.
   */
  chargeTau: 780,
  /** degrees a zone loses per tonne per hour of charge, per degree of sub-cooling */
  loadK: 0.0045,
  /** degrees the mouth loses per slab per hour above nominal pace, and gains below it */
  exitGapPerSpeed: 3.2,
  /** degrees the mouth loses per degree of charge sub-cooling */
  coldExitK: 0.2,
  /** a slab leaves the furnace at a temperature its whole soak history set, so the
   *  discharge reading is a weighted memory of the zones rather than the last one */
  wSoak1: 0.55,
  wSoak2: 0.30,
  wDisch: 0.15,

  /** thermal lags, seconds */
  tauPre: 420,
  tauSoak: 300,
  tauDisch: 360,
  tauCool: 2400,
  tauLine: 120,
  tauSlab: 520,
  tauSlabCold: 1500,
  exitLagTau: 210,
  tauGas: 90,
  tauShell: 1500,
  tauPress: 90,
  /** a furnace that has lost its fire falls towards this, not towards ambient */
  tStandby: 150,

  /** a fully clogged burner train loses this much zone temperature */
  clogDrop: 130,
  /**
   * An un-discharged command error does not simply sit there: the crew feeds more
   * fuel to make the chamber answer, so the overshoot it produces is somewhat
   * larger than the step that caused it, and it is bounded because a real controller
   * is not capable of wind-up without limit.
   */
  windUpK: 1.2,
  windUpMax: 40,
  /** how long the chamber takes to discharge a command error, seconds */
  windUpTau: 1500,
  dischDroop: 14,
  /** gap wider than this means the chamber has not answered the last movement */
  settleBand: 10,

  /** firing demand as a fraction of nominal: holding term plus gap-proportional term */
  firingBase: 0.95,
  firingGap: 0.9,
  gapRef: 250,
  /** gas burned per second at nominal firing, and its energy content */
  burnNom: 0.32,
  gjPerM3: 0.038,

  /** combustion air model: lean when trimmed, richer when fired hard, high when a burner is not taking gas */
  o2Base: 3.2,
  o2Ideal: 3.0,
  o2Trim: 5.5,
  o2Clog: 2.6,
  o2Rich: 1.9,
  /** the operating limit the procedure quotes for raising a setpoint */
  o2Limit: 5.5,
  /** fuel wasted per point of departure from the ideal oxygen reading */
  wasteK: 0.045,
  wasteConflict: 0.12,
  wasteRatio: 0.18,

  /** rate-of-change guardrails, taken straight out of the operating procedure */
  settleS: 360,
  maxStepC: 20,
  maxSpeedStep: 4,
  maxTrim: 12,
  maxAirStep: 0.12,
  conflictTau: 900,
  ratioTau: 540,

  /** furnace pressure at the roof */
  pressNom: 12,
  /**
   * A flue damper stuck closed only shows up as load: the extraction that is left
   * can hold the furnace quiet at the reference firing rate, and the chamber goes
   * positive when the crew starts pushing gas in to chase a temperature the charge
   * will not take. That is what makes the blockage a latent condition rather than a
   * standing sentence, and why the gas the procedure adds is what blows it over.
   */
  pressStuck: 60,
  pressStuckFire: 0.8,
  pressIdf: 14,
  pressFire: 34,
  pressConflict: 30,
  pressRiseMbarPerMin: 6,
  /** pressure at which combustion lifts off the burners, and the hard trip */
  pressFlame: 46,
  pressTrip: 56,
  /** the roof pressure annunciator, which is also the number the emergency section quotes */
  pressAlarm: 35,
  /** gas admitted to a chamber with no flame behind the open train, m3/s */
  admitM3s: 0.5,
  /** a burner train that is shut but passing, m3/s */
  leakM3s: 0.02,
  /**
   * Scenario magnitudes. A plant state says what is wrong with this furnace in
   * the same register-style vocabulary the transfer plant uses - a list of things
   * left isolated or never proved back - so the size of each defect is stated
   * once here instead of being repeated on every plant record.
   */
  clogSlow: 0.3,
  zoneBiasSlow: 15,
  /** flue extraction clears this much chamber volume per second */
  purgeM3s: 0.09,
  /** unburnt gas inventory at which re-ignition becomes a deflagration, m3 */
  lflM3: 40,
  /** hot enough refractory or slab in the chamber is an ignition source */
  relightT: 700,
  /** share of the resident charge condemned by a flame-out */
  condemnFrac: 0.7,
  /** tonnes-equivalent charged to the repair account when the chamber pops */
  popFixT: 30,

  /** shell and refractory */
  shellFrac: 0.155,
  shellInsulLoss: 0.28,
  shellMixCool: 55,
  shellAlarm: 260,
  /** the design temperature of the soak roof panels */
  refrLimit: 1320,
  refrK: 0.0011,
  refFixT: 20,

  /** the scheduled heat: what this shift is trying to hand the mill */
  heatGoodT: 96,
  progressRate: 0.0156,
  runoutFactor: 1.1,
  /** quality plan scrap allowance, as a fraction of the scheduled heat */
  scrapAllowFrac: 0.07,
  /** how many slabs have to be rejected for temperature before the heat is named
   *  after the defect rather than after the schedule */
  rejectSlabs: 1,
  /** scale formed per degree of over-temperature, as a fraction of the element */
  scalePerC: 0.00009,
  /** unavoidable scale even on a slab sitting exactly at the window centre */
  burnFloor: 0.004,
  /** specific energy a well-run furnace is entitled to burn, GJ per tonne charged */
  refGjPerT: 0.60,

  /** seconds from the pyrometer to the gas stop, and to operate it */
  walkS: 75,
  actS: 45,
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const furnaceOpsTwin: TwinDef = {
  id: 'furnace_operating',
  label: 'Reheat furnace 4, production heat-up of slabs',
  unit: 'Rolling mill reheat shop, furnace 4',
  hazardKind: 'condemned heat: scrapped metal, flame-out and refractory over-temperature',
  vars: VARS,
  discs: DISCS,
  params: P,
  iface: {
    /**
     * The honest progress variable is the tonnage of in-spec metal the mill has
     * been handed, not the discharge temperature. A hot slab the mill refuses is
     * not progress, and a temperature would also let the run-out loop claim
     * success on a furnace that is producing nothing but scrap. Tonnes is the
     * only quantity that both the schedule and the quality plan are measured on.
     */
    progress: 'goodT',
    target: 'heatGoodT',
    rate: 'progressRate',
    runFlag: 'BURN',
    stopFlag: 'STOP',
    alarm: 'hiAl',
    /**
     * A reheat furnace does not release anything to the environment; it destroys
     * metal. So the hazard quantity is tonnes lost beyond the allowance the
     * quality plan already carries - the number that reaches the mill as a
     * rejection and the plant as a scrap sheet. A flame-out or a popped chamber
     * adds the tonnage resident in the furnace, because that charge is genuinely
     * condemned the moment combustion lifts off. Zero means nothing has gone
     * wrong yet, which is what the runner's hazard accounting needs it to mean.
     */
    hazard: 'hazardT',
    clock: 't',
    runoutFactor: 1.1,
    /**
     * A furnace breathes in minutes. The operating procedure's own settling rule
     * is six minutes between movements, so an integration step of a minute still
     * resolves every movement, crossing and window judgement the procedure
     * depends on, and a heat costs the same compute as a cure cycle instead of
     * four times it.
     */
    tickS: 60,
    bias: 'tcBias',
    scale: 'scale',
    failOnDemand: 'TRIPFAIL',
  },
  display: {
    soak1T: { label: 'SOAK-1 zone', unit: 'C', danger: 1320 },
    soak2T: { label: 'SOAK-2 zone', unit: 'C', danger: 1320 },
    dischT: { label: 'Discharge zone', unit: 'C', danger: 1320 },
    exitT: { label: 'Slab at the mouth', unit: 'C', danger: 1278 },
    press: { label: 'Furnace pressure', unit: 'mbar', danger: 46 },
    o2: { label: 'Flue gas O2', unit: '%' },
    shellT: { label: 'Shell temperature', unit: 'C', danger: 260 },
    goodT: { label: 'Good tonnes to the mill', unit: 't' },
    scrapT: { label: 'Scrapped', unit: 't', danger: 6.7 },
    lineSpeed: { label: 'Hearth speed', unit: 'slabs/h' },
  },

  varIndex(n) { return VARS.indexOf(n); },
  discIndex(n) { return DISCS.indexOf(n); },

  init(s, o, d, k, p, cfg: TwinConfig) {
    // the shift starts mid-heat: the furnace is at temperature on the grade before
    // this one, the mill has asked for hotter slabs, and the crew's job is to get
    // soak-1 up there without losing the rolling window
    s[o + 0] = 985;
    s[o + 1] = 1215;
    s[o + 2] = 1258;
    s[o + 3] = 1244;
    s[o + 4] = 985;
    s[o + 5] = 1215;
    s[o + 6] = 1258;
    s[o + 7] = p.speedNom;
    s[o + 8] = 0;
    s[o + 9] = 1;
    s[o + 10] = p.speedNom;
    s[o + 11] = p.firingBase * 100;
    s[o + 12] = p.o2Base;
    s[o + 13] = p.pressNom;
    // startLevelFrac becomes "how far through the furnace the tracked element is"
    s[o + 14] = clamp(cfg.startLevelFrac, 0.05, 0.95);
    s[o + 15] = 1205;
    s[o + 16] = 1235;
    s[o + 18] = 1235;
    s[o + 19] = 0; s[o + 20] = 0; s[o + 21] = 0; s[o + 22] = 0; s[o + 23] = 0;
    s[o + 24] = p.tAmbient + 190;
    s[o + 25] = 0;
    s[o + 26] = 0;
    s[o + 27] = p.settleS * 3;
    s[o + 28] = 0; s[o + 29] = 0; s[o + 30] = 0;
    s[o + 31] = 0; s[o + 32] = -1; s[o + 33] = 0; s[o + 34] = 0; s[o + 35] = 0;
    s[o + 36] = p.pressNom; s[o + 37] = 0; s[o + 38] = 0; s[o + 39] = 0;
    // the controller has accepted every setpoint the furnace is already sitting on,
    // otherwise the first tick would read the initial condition as a movement
    s[o + 40] = s[o + 4]; s[o + 41] = s[o + 5]; s[o + 42] = s[o + 6];
    s[o + 43] = s[o + 7]; s[o + 44] = s[o + 8]; s[o + 45] = s[o + 9];
    s[o + 46] = 0; s[o + 47] = 0; s[o + 48] = 0; s[o + 49] = 0; s[o + 50] = 0; s[o + 51] = 0;

    const cold = cfg.preIsolated.includes('COLD_CHARGE');
    s[o + 17] = cold ? p.chargeCold : p.chargeHot;

    d[k + 0] = 1;
    d[k + 1] = 1;
    d[k + 2] = cfg.preIsolated.includes('IDF') ? 0 : 1;
    d[k + 3] = 1;
    d[k + 4] = cfg.preIsolated.includes('MIX') ? 0 : 1;
    d[k + 5] = 1;
    d[k + 6] = 0;
    d[k + 7] = cfg.preIsolated.includes('ALARM') || cfg.protection['lah'] === false ? 0 : 1;
    d[k + 8] = cfg.preIsolated.includes('TRIP') || cfg.protection['pis'] === false ? 0 : 1;
    d[k + 9] = 0;
    d[k + 10] = cfg.indicatorBias;
    d[k + 11] = 1;
    d[k + 12] = cfg.preIsolated.includes('BURNER_CLOG') ? p.clogSlow : 0;
    d[k + 13] = cfg.preIsolated.includes('DAMPER_STUCK') ? 1 : 0;
    d[k + 14] = cold ? 1 : 0;
    d[k + 15] = cfg.preIsolated.includes('TC_SOAK') ? p.zoneBiasSlow : 0;
    d[k + 16] = cfg.preIsolated.includes('GASLEAK') ? 1 : 0;
    d[k + 17] = cfg.protection['interlock'] === true ? 1 : 0;
  },

  advance(s, o, d, k, p, dt) {
    const stop = d[k + 6];
    const run = 1 - stop;
    const burn = d[k + 0] * run;
    const fan = d[k + 1] * run;
    const idf = d[k + 2] * run;
    const push = d[k + 3] * run;
    const mix = d[k + 4] * run;
    const mill = d[k + 5] * run;
    const clog = d[k + 12];
    const stuck = d[k + 13];
    const leak = d[k + 16];
    const capa = d[k + 11];

    // ---- rate-of-change guardrails -------------------------------------
    // Six commanded setpoints, six remembered setpoints. A difference is a
    // movement; the size relative to the rule for that lever is a violation; a
    // movement taken while the chamber is still answering the last one, or inside
    // the settling interval, is an un-settled one. All three feed the same
    // physical state: the error the loop has integrated but the furnace has not
    // yet discharged.
    let changed = 0;
    let bigMove = 0;
    for (let i = 4; i <= 9; i++) {
      const at = o + i;
      const delta = s[at] - s[at + 36];
      if (delta !== 0) {
        changed++;
        const a = delta < 0 ? -delta : delta;
        const allow = i < 7 ? p.maxStepC : i === 7 ? p.maxSpeedStep : i === 8 ? p.maxTrim : p.maxAirStep;
        // the chamber is judged against the command it was *already* holding: a
        // setpoint change is by definition a gap, so only a change made while the
        // last change was still being chased counts as an un-settled one. The hearth
        // speed is not in the temperature loop, so moving it cannot wind it up.
        const lagging = i === 5
          ? (s[o + 41] - s[o + 1]) > p.settleBand
          : i === 6 ? (s[o + 42] - s[o + 2]) > p.settleBand : false;
        const early = i !== 7 && (s[o + 27] < p.settleS || lagging);
        s[o + 28] = s[o + 28] + (a > allow ? a - allow : 0) + (early ? a : 0);
        if (i < 7) {
          if (a > p.maxStepC && a > bigMove) bigMove = a;
          // heat asked for while the flue gas is already lean is fuel the chamber
          // is not burning: it comes back later as gas, scrap and a hot spot
          if (s[o + 12] > p.o2Limit) s[o + 47] = Math.min(1, s[o + 47] + a / 40);
        }
      }
      s[at + 36] = s[at];
    }
    if (changed > 1) {
      s[o + 29] = Math.min(1, s[o + 29] + 0.3 * changed);
      s[o + 51] = s[o + 51] + 1;
    }
    if (changed > 0) {
      s[o + 27] = 0;
      if (bigMove > s[o + 46]) s[o + 46] = bigMove;
    } else {
      s[o + 27] = s[o + 27] + dt;
    }
    // the chamber needs several thermal time constants to discharge a command
    // error, not one settling interval, or the overshoot would be gone before the
    // metal ever arrived to feel it
    s[o + 28] = s[o + 28] - s[o + 28] * clamp(dt / p.windUpTau, 0, 1);
    s[o + 29] = s[o + 29] - s[o + 29] * clamp(dt / p.conflictTau, 0, 1);
    s[o + 47] = s[o + 47] - s[o + 47] * clamp(dt / p.ratioTau, 0, 1);
    const windUp = Math.min(s[o + 28], p.windUpMax) * p.windUpK;

    // ---- firing and combustion ----------------------------------------
    const gPre = Math.max(0, s[o + 4] - s[o + 0]);
    const gS1 = Math.max(0, s[o + 5] - s[o + 1]);
    const gS2 = Math.max(0, s[o + 6] - s[o + 2]);
    const gap = Math.max(gPre, gS1, gS2);
    const tonsPerHour = s[o + 10] * p.slabMass;
    const load = tonsPerHour * (s[o + 17] < p.chargeHot ? (p.chargeHot - s[o + 17]) * p.loadK : 0);
    const waste = 1
      + Math.abs(s[o + 12] - p.o2Ideal) * p.wasteK
      + s[o + 29] * p.wasteConflict
      + s[o + 47] * p.wasteRatio;
    const trim = 1 + s[o + 8] / 100;
    const demand = p.firingBase + (gap / p.gapRef) * p.firingGap;
    // heat that actually reaches the chamber: no combustion air, no flame, and a
    // clogged train passes gas it cannot burn
    const firing = clamp(burn * fan * demand * trim * capa * (1 - clog), 0, 2.4);
    // gas the meter records: what the controller asked for, plus whatever the air
    // ratio is throwing away. Both a lean and a rich furnace burn more fuel for the
    // same degrees, which is the only reason a trim limit is worth having.
    const fire = clamp(burn * fan * demand * trim * waste, 0, 2.8);
    s[o + 11] = firing * 100;
    // combustion that has lifted off a positive furnace is not burning, however
    // much gas the open train is admitting
    const flameOn = firing > 0.08 && s[o + 34] === 0 ? 1 : 0;
    const gasM3s = fire * p.burnNom;
    s[o + 23] = s[o + 23] + gasM3s * p.gjPerM3 * dt;

    const o2Target = flameOn === 0
      ? (fan === 1 ? p.o2Base + p.o2Trim * (s[o + 9] - 1) + p.o2Clog * clog : 0)
      : p.o2Base + p.o2Trim * (s[o + 9] - 1) + p.o2Clog * clog - p.o2Rich * Math.max(0, firing - 1);
    s[o + 12] = s[o + 12] + (Math.max(0, o2Target) - s[o + 12]) * clamp(dt / p.tauGas, 0, 1);

    // ---- zones ---------------------------------------------------------
    const tPre = s[o + 4] - load * 0.9 - clog * 40 - s[o + 47] * 30;
    const tS1 = s[o + 5] + windUp - load * 0.45 - clog * p.clogDrop - s[o + 47] * 40;
    const tS2 = s[o + 6] + windUp * 0.8 - load * 0.3 - clog * p.clogDrop * 0.7 - s[o + 47] * 25;
    const tDs = s[o + 6] + windUp * 0.5 - p.dischDroop - load * 0.18 - clog * 30;
    const kPre = clamp(dt / (flameOn === 1 ? p.tauPre : p.tauCool), 0, 1);
    const kS1 = clamp(dt / (flameOn === 1 ? p.tauSoak : p.tauCool), 0, 1);
    const kS2 = clamp(dt / (flameOn === 1 ? p.tauSoak : p.tauCool), 0, 1);
    const kDs = clamp(dt / (flameOn === 1 ? p.tauDisch : p.tauCool), 0, 1);
    s[o + 0] = s[o + 0] + ((flameOn === 1 ? tPre : p.tStandby) - s[o + 0]) * kPre;
    s[o + 1] = s[o + 1] + ((flameOn === 1 ? tS1 : p.tStandby) - s[o + 1]) * kS1;
    s[o + 2] = s[o + 2] + ((flameOn === 1 ? tS2 : p.tStandby) - s[o + 2]) * kS2;
    s[o + 3] = s[o + 3] + ((flameOn === 1 ? tDs : p.tStandby) - s[o + 3]) * kDs;

    // ---- hearth and charge ---------------------------------------------
    // the pusher only moves metal when the mill is taking it, and the tracked
    // element reloads from the charge temperature each time it leaves the mouth
    const speedTarget = push * mill * s[o + 7];
    s[o + 10] = s[o + 10] + (speedTarget - s[o + 10]) * clamp(dt / p.tauLine, 0, 1);
    s[o + 14] = s[o + 14] + (s[o + 10] / p.positions) * dt / 3600;
    if (s[o + 14] >= 1) {
      s[o + 14] = s[o + 14] - 1;
      s[o + 15] = s[o + 17];
    }
    const pos = s[o + 14];
    const profile = pos < 0.3 ? s[o + 0] : pos < 0.55 ? s[o + 1] : pos < 0.82 ? s[o + 2] : s[o + 3];
    const tauS = s[o + 17] < 300 ? p.tauSlabCold : p.tauSlab;
    s[o + 15] = s[o + 15] + (profile - s[o + 15]) * clamp(dt / tauS, 0, 1);
    if (s[o + 15] > s[o + 18]) s[o + 18] = s[o + 15];
    // the metal leaving carries the memory of every zone it passed, and slowing the
    // line buys it residence, which is the only honest answer to a cold charge
    const hist = s[o + 1] * p.wSoak1 + s[o + 2] * p.wSoak2 + s[o + 3] * p.wDisch;
    const hotCap = Math.max(s[o + 1], s[o + 2], s[o + 3]) - 4;
    const mouthWant = hist
      + p.exitGapPerSpeed * (p.speedNom - s[o + 10])
      - p.coldExitK * Math.max(0, p.chargeHot - s[o + 17]);
    const mouth = Math.min(mouthWant, hotCap);
    s[o + 16] = s[o + 16] + (mouth - s[o + 16]) * clamp(dt / p.exitLagTau, 0, 1);
    s[o + 17] = s[o + 17] + ((d[k + 14] === 1 ? p.chargeCold : p.chargeHot) - s[o + 17]) * clamp(dt / p.chargeTau, 0, 1);

    // ---- discharge judged against the rolling window -------------------
    const flow = Math.min(s[o + 10], p.chargeCap) * p.slabMass / 3600;
    const dm = flow * dt;
    const ex = s[o + 16];
    let good = 0;
    let scrap = 0;
    let scale = 0;
    if (ex < p.tCold) {
      scrap = dm * clamp((p.tCold - ex) / p.coldBand, 0, 1);
      scale = Math.min(dm - scrap, dm * p.burnFloor * 0.5);
      good = dm - scrap - scale;
      s[o + 50] = s[o + 50] + scrap;
    } else if (ex > p.tHot) {
      scrap = dm * clamp((ex - p.tHot) / p.hotBand, 0, 1);
      scale = Math.min(dm - scrap, dm * (p.burnFloor + (ex - p.tHot) * p.scalePerC));
      good = dm - scrap - scale;
      s[o + 49] = s[o + 49] + scrap;
    } else {
      const over = Math.max(0, ex - p.tCentre);
      scale = dm * (p.burnFloor + (over / (p.tHot - p.tCentre)) * p.burnFloor * 6);
      good = dm - scale;
    }
    s[o + 19] = s[o + 19] + good;
    s[o + 20] = s[o + 20] + scrap;
    s[o + 21] = s[o + 21] + scale;
    s[o + 22] = s[o + 22] + dm;
    s[o + 37] = s[o + 37] + Math.abs(ex - p.tCentre) * dt;
    // burning with no metal moving is pure loss, and it is what the mill calls downtime
    s[o + 38] = s[o + 38] + (burn * (flow < p.speedNom * p.slabMass / 7200 ? 1 : 0)) * dt;

    // ---- furnace pressure ----------------------------------------------
    // pressure follows the gas actually going in, not the heat that lands, which
    // is why a clogged train and a control fight both make a positive furnace
    const pressTarget = p.pressNom
      // a stuck damper does not add a fixed head: the loss of the flue path makes
      // the chamber hold back-pressure in proportion to the square of the gas flow
      // through the burners, which is why a furnace that is barely firing survives
      // with a stuck damper and one being pushed for heat does not
      + p.pressStuck * stuck * Math.max(0, fire * fire - p.pressStuckFire)
      + p.pressIdf * (1 - idf)
      + p.pressFire * Math.max(0, fire - 1.05)
      + p.pressConflict * s[o + 29];
    s[o + 13] = s[o + 13] + (pressTarget - s[o + 13]) * clamp(dt / p.tauPress, 0, 1);
    if (s[o + 13] > s[o + 36]) s[o + 36] = s[o + 13];

    // ---- unburnt gas, flame-out, deflagration --------------------------
    // gas in the chamber because there is no flame behind the open train, because
    // a train is passing while shut, or because heat was pushed into a furnace that
    // was already too lean to burn it
    const unburnt = burn * (1 - flameOn) * p.admitM3s
      + leak * (1 - burn) * p.leakM3s
      + s[o + 47] * burn * p.leakM3s * 0.5;
    s[o + 39] = s[o + 39] + unburnt * dt;
    if (idf === 1) {
      s[o + 39] = s[o + 39] - p.purgeM3s * dt * (burn === 0 ? 1 : 0.25);
      if (s[o + 39] < 0) s[o + 39] = 0;
    }

    // combustion lifts off a positive furnace: the charge in the chamber is
    // ruined and, if the protection does not close the trains, gas keeps coming
    if (s[o + 34] === 0 && flameOn === 1 && s[o + 13] >= p.pressFlame) s[o + 34] = 1;
    if (s[o + 48] === 0 && s[o + 39] > p.lflM3 && s[o + 0] > p.relightT) {
      s[o + 48] = 1;
      s[o + 1] = s[o + 1] + 180;
      s[o + 24] = s[o + 24] + 130;
      s[o + 25] = Math.min(1.5, s[o + 25] + 0.6);
      s[o + 39] = 0;
      d[k + 6] = 1;
    }

    // ---- shell and refractory -------------------------------------------
    const hotZone = s[o + 1] > s[o + 2] ? s[o + 1] : s[o + 2];
    if (hotZone > p.refrLimit) {
      s[o + 25] = Math.min(1.5, s[o + 25] + (hotZone - p.refrLimit) * p.refrK * dt / 60);
    }
    if (s[o + 25] >= 1) s[o + 35] = 1;
    const shellTarget = p.tAmbient + hotZone * (p.shellFrac + s[o + 25] * p.shellInsulLoss) + (mix === 0 ? p.shellMixCool : 0);
    s[o + 24] = s[o + 24] + (shellTarget - s[o + 24]) * clamp(dt / p.tauShell, 0, 1);

    // ---- what has actually been lost ------------------------------------
    // derived, never accumulated, so the same tonnage can never be counted twice:
    // the metal beyond the quality allowance, plus whatever a flame-out, a popped
    // chamber or a failed roof has condemned outright
    const condemned = (s[o + 34] === 1 ? p.inFurnaceT * p.condemnFrac : 0)
      + (s[o + 48] === 1 ? p.inFurnaceT * p.condemnFrac + p.popFixT : 0)
      + (s[o + 35] === 1 ? p.refFixT : 0);
    s[o + 30] = condemned + Math.max(0, s[o + 20] - p.scrapAllowFrac * p.heatGoodT);

    // ---- protection demands --------------------------------------------
    const acts = d[k + 8] * (1 - d[k + 9]) + d[k + 17];
    if (s[o + 31] === 0 && d[k + 7] === 1
      && (s[o + 16] >= p.tAlarm || s[o + 15] >= p.tAlarm
        || s[o + 24] >= p.shellAlarm || s[o + 13] >= p.pressAlarm)) {
      s[o + 31] = 1;
      s[o + 32] = 0;
    }
    if (s[o + 31] === 1 && s[o + 32] >= 0) s[o + 32] = s[o + 32] + dt;
    if (s[o + 13] >= p.pressTrip && s[o + 33] === 0) {
      s[o + 33] = 1;
      if (acts >= 1) d[k + 6] = 1;
    }
    if (s[o + 34] === 1 && s[o + 33] === 0 && acts >= 1) {
      s[o + 33] = 1;
      d[k + 6] = 1;
    }

    s[o + 26] = s[o + 26] + dt;
  },

  indication(s, o, d, k, name) {
    // a replaced pyrometer that reads high is the whole reason a crew acts late:
    // the metal at the mouth is cold, the faceplate says it is hot, so nothing in
    // the control room invites a correction
    if (name === 'exitT') return s[o + 16] + d[k + 10];
    if (name === 'slabT') return s[o + 15] + d[k + 10];
    if (name === 'peakSlabT') return s[o + 18] + d[k + 10];
    if (name === 'soak1T') return s[o + 1] + d[k + 15];
    if (name === 'soak2T') return s[o + 2] + d[k + 15];
    const i = furnaceOpsTwin.varIndex(name);
    return i >= 0 ? s[o + i] : 0;
  },

  magnitudes(s, o, d, k) {
    const charged = s[o + 22];
    const gj = s[o + 23];
    return {
      tonnesGood: s[o + 19],
      tonnesScrap: s[o + 20],
      coldScrapT: s[o + 50],
      hotScrapT: s[o + 49],
      burnoffT: s[o + 21],
      tonnesCharged: charged,
      scrapPct: charged > 0 ? (s[o + 20] / charged) * 100 : 0,
      gasM3: gj / P.gjPerM3,
      gjBurned: gj,
      gjPerTonne: charged > 0 ? gj / charged : 0,
      mwhPerTonne: charged > 0 ? gj / charged / 3.6 : 0,
      gasAboveRefM3: Math.max(0, gj - P.refGjPerT * charged) / P.gjPerM3,
      co2T: (gj / P.gjPerM3) * 0.00204,
      exitTempC: s[o + 16],
      exitIndicatedC: s[o + 16] + d[k + 10],
      meanExitDevC: s[o + 37] / Math.max(1, s[o + 26]),
      peakSlabC: s[o + 18],
      peakShellC: s[o + 24],
      peakPressMbar: s[o + 36],
      flueO2Pct: s[o + 12],
      downtimeMin: s[o + 38] / 60,
      shiftMin: s[o + 26] / 60,
      hazardT: s[o + 30],
      unburntGasM3: s[o + 39],
      flameOut: s[o + 34],
      deflagrated: s[o + 48],
      refractoryFailed: s[o + 35],
      tripped: s[o + 33],
      damageIndex: s[o + 25],
      heatShortfallT: Math.max(0, P.heatGoodT - s[o + 19]),
      scrapAllowanceT: P.scrapAllowFrac * P.heatGoodT,
      alarmLeadS: s[o + 32],
      /**
       * The response budgets a furnace reader wants, in the same style as the
       * overfill guidance's RT2/RT3: how much of the settling rule the last
       * movement actually had, how much command error the loop is carrying, and
       * how long the pressure has left before combustion lifts off.
       */
      settleRequiredS: P.settleS,
      settleObservedS: s[o + 27],
      windUpC: s[o + 28],
      largestMoveC: s[o + 46],
      twoLeverMoves: s[o + 51],
      fuelTrimPct: s[o + 8],
      airTrimPct: (s[o + 9] - 1) * 100,
      zoneLagS: P.tauSoak,
      slabHeatLagS: s[o + 17] < 300 ? P.tauSlabCold : P.tauSlab,
      pressureMarginMbar: Math.max(0, P.pressFlame - s[o + 13]),
      timeToFlameOutS: Math.max(0, P.pressFlame - s[o + 13]) / (P.pressRiseMbarPerMin / 60),
      chargeColdC: Math.max(0, P.chargeHot - s[o + 17]),
      residentChargeT: P.inFurnaceT,
      responseRequiredS: P.walkS + P.actS,
      releaseM3: 0,
    };
  },

  classify(s, o, d, k, p) {
    const allow = p.scrapAllowFrac * p.heatGoodT;
    // A temperature reject is not a tonnage question. Metal that left the
    // furnace above the rolling window cannot be put back, and metal that left
    // below it cannot be rolled, so one slab's worth of either names the heat.
    // The wider allowance is what the mill tolerates in total scrap - scale,
    // trim, cold ends - not what it accepts as a reject.
    const reject = p.rejectSlabs * p.slabMass;
    if (s[o + 48] === 1) return 'deflagration';
    if (s[o + 35] === 1) return 'refractory_overtemp';
    if (s[o + 34] === 1) return 'flame_out';
    if (s[o + 49] > reject) return 'overheat_scrap';
    if (s[o + 50] > reject) return 'cold_slab_scrap';
    if (s[o + 20] > allow) return 'scrap_batch';
    if (s[o + 19] < p.heatGoodT * 0.55) return 'production_hold';
    if (s[o + 33] === 1 || d[k + 6] === 1) return 'trip_stop';
    if (s[o + 19] < p.heatGoodT * 0.9) return 'short_batch';
    return 'normal';
  },

  hazardNote(s, o, d, k, p) {
    if (s[o + 48] === 1) return `Deflagration of ${s[o + 39] > 0 ? s[o + 39].toFixed(0) : (p.lflM3).toFixed(0)} m3 of unburnt gas in the chamber - ${s[o + 30].toFixed(0)} t of slab condemned`;
    if (s[o + 35] === 1) return `Refractory failed - soak zone at ${s[o + 18].toFixed(0)} C, shell reached ${s[o + 24].toFixed(0)} C`;
    if (s[o + 34] === 1) return `Combustion lifted off at ${s[o + 36].toFixed(0)} mbar - ${p.inFurnaceT.toFixed(0)} t of charge in the furnace is ruined`;
    if (s[o + 49] > p.scrapAllowFrac * p.heatGoodT) return `${s[o + 49].toFixed(1)} t of slab over-heated past ${p.tHot} C and scrapped, ${s[o + 21].toFixed(1)} t burned off as scale`;
    if (s[o + 50] > p.scrapAllowFrac * p.heatGoodT) return `${s[o + 50].toFixed(1)} t of slab below ${p.tCold} C and scrapped before it could be rolled`;
    if (s[o + 20] > p.scrapAllowFrac * p.heatGoodT) return `${s[o + 20].toFixed(1)} t scrapped against a ${(p.scrapAllowFrac * p.heatGoodT).toFixed(1)} t allowance`;
    if (s[o + 19] < p.heatGoodT * 0.55) return `The mill took ${s[o + 19].toFixed(1)} t of a scheduled ${p.heatGoodT.toFixed(0)} t - ${(s[o + 38] / 60).toFixed(0)} min of furnace idle`;
    if (d[k + 6] === 1 && s[o + 19] < p.heatGoodT * 0.9) return `Furnace shut down with ${s[o + 19].toFixed(1)} t of ${p.heatGoodT.toFixed(0)} t delivered`;
    return '';
  },
};
