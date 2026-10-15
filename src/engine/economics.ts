import costs from '../../data/costs.json';
/**
 * Consequence economics.
 *
 * The physics produces magnitudes - cubic metres, megajoules, degrees,
 * hours. Money is a separate, auditable layer so that a judge can disagree
 * with a price without having to disagree with the model. Every unit rate
 * carries a source string in data/costs.json and the UI prints it.
 */

export interface CostBreakdown {
  totalEur: number;
  items: { label: string; eur: number; source: string }[];
  downtimeH: number;
  /** expected loss if the event escalates, kept separate from booked cost */
  escalationEur: number;
  reportable: boolean;
}

const C = costs as unknown as {
  products: Record<string, { eurPerM3: number; recoveryContained: number; recoveryEscaped: number; flammable: boolean }>;
  terminal: Record<string, number>;
  furnace: Record<string, number>;
  furnaceOperating: {
    scrapEurPerTonne: number;
    goodEurPerTonne: number;
    burnOffEurPerTonne: number;
    gasEurPerKwh: number;
    gasKwhPerM3: number;
    lineIdleEurPerHour: number;
    flameOutRepairEur: number;
    flameOutHoldH: number;
    deflagrationRepairEur: number;
    deflagrationHoldH: number;
    refractoryRepairEur: number;
    refractoryHoldH: number;
    surveyFlatEur: number;
    surveyHoldH: number;
    reheatFlatEur: number;
    reheatHoldH: number;
  };
  fines: { reportableThresholdM3: number; fixedEur: number; perEscapedM3Eur: number; capEur: number };
  escalation: { ignitionProbabilityPerEvent: number; catastrophicEur: number; catastrophicFurnaceEur: number; byClass: Record<string, number> };
};

export function costTank(outcome: string, mag: Record<string, number>, product: string): CostBreakdown {
  const pr = C.products[product] ?? C.products.toluene;
  const release = mag.releaseM3 ?? 0;
  const escaped = mag.escapedM3 ?? 0;
  const contained = mag.containedM3 ?? 0;
  const diverted = mag.divertedM3 ?? 0;
  const items: CostBreakdown['items'] = [];
  const add = (label: string, eur: number, source: string) => {
    if (eur > 0.5) items.push({ label, eur, source });
  };

  if (release > 0) {
    const lostM3 = release - contained * pr.recoveryContained - (release - contained - escaped) * pr.recoveryContained;
    add('Product lost', Math.max(0, lostM3) * pr.eurPerM3, 'product price, terminal cost basis');
    add('Recovery and disposal from containment', contained * (1 - pr.recoveryContained) * C.terminal.cleanupPerContainedM3, 'contractor rate, quoted range midpoint');
    add('Off-site remediation', escaped * C.terminal.remediationPerEscapedM3, 'remediation cost per m3 released to environment');
    if (escaped > C.fines.reportableThresholdM3 || release > C.fines.reportableThresholdM3 * 4) {
      add('Regulatory penalty', Math.min(C.fines.capEur, C.fines.fixedEur + escaped * C.fines.perEscapedM3Eur), 'enforcement penalty band, median of published determinations');
      add('Investigation, incident management and legal', C.terminal.investigationFlatEur, 'internal cost of a reportable incident');
    }
    const outHours = outcome === 'tank_breach' ? 168 : outcome === 'overfill' || outcome === 'line_failure' ? 48 : outcome === 'containment_escape' ? 72 : 12;
    add('Rack and tank out of service', outHours * C.terminal.rackIdleEurPerHour, 'idle cost of a loading bay plus the tank');
  }
  if (diverted > 1) {
    add('Off-spec product and line flushing', diverted * pr.eurPerM3 * 0.35 + C.terminal.flushFlatEur, 'downgrade and flush cost per m3 of commingled product');
  }
  if (outcome === 'no_flow' || outcome === 'short_batch') {
    add('Aborted transfer and re-planning', outcome === 'no_flow' ? C.terminal.abortedBatchEur : C.terminal.abortedBatchEur * 0.6, 'demurrage and re-dispatch of the road tanker');
  }
  if (outcome === 'trip_stop') {
    add('Short transfer, vehicle detention', C.terminal.abortedBatchEur * 0.4, 'partial batch, tanker held at the rack');
  }

  const total = items.reduce((a, b) => a + b.eur, 0);
  const escProb = C.escalation.byClass[outcome] ?? (release > 0 ? C.escalation.ignitionProbabilityPerEvent : 0);
  return {
    totalEur: total,
    items,
    downtimeH: items.find((i) => i.label.includes('out of service'))?.eur
      ? (items.find((i) => i.label.includes('out of service'))!.eur / C.terminal.rackIdleEurPerHour) : 0,
    escalationEur: escProb * C.escalation.catastrophicEur,
    reportable: escaped > C.fines.reportableThresholdM3 || release > C.fines.reportableThresholdM3 * 4,
  };
}

export function costFurnace(outcome: string, mag: Record<string, number>): CostBreakdown {
  const items: CostBreakdown['items'] = [];
  const add = (label: string, eur: number, source: string) => {
    if (eur > 0.5) items.push({ label, eur, source });
  };
  let downtimeH = 0;

  if (outcome === 'deflagration') {
    add('Furnace shell, tubes and refractory repair', C.furnace.deflagrationRepairEur, 'post-event rebuild estimate for a mid-size reheat furnace');
    downtimeH = C.furnace.deflagrationOutageH;
  } else if (outcome === 'refractory_damage') {
    add('Lining cut-out and re-gun', C.furnace.refractoryRepairEur, 'refractory contractor rate for a partial re-line');
    downtimeH = C.furnace.refractoryOutageH;
  } else if (outcome === 'shell_hotspot') {
    add('Emergency cooling, inspection and patch', C.furnace.hotspotRepairEur, 'unscheduled outage for a shell hot spot');
    downtimeH = C.furnace.hotspotOutageH;
  } else if (outcome === 'hot_start') {
    add('Ultrasonic lining survey and monitoring', C.furnace.inspectionFlatEur, 'NDT campaign on a suspect lining');
    downtimeH = C.furnace.inspectionOutageH;
  } else if (outcome === 'no_light_off') {
    add('Repeat heat-up, gas and labour', C.furnace.repeatHeatupEur, 'fuel and crew cost of an aborted cure cycle');
    downtimeH = 3;
  } else if (outcome === 'trip_stop') {
    add('Restart after burner management trip', C.furnace.tripRestartEur, 'purge and re-light labour and fuel');
    downtimeH = 4;
  }

  if (downtimeH > 0) add('Line idle', downtimeH * C.furnace.lineIdleEurPerHour, 'lost reheat capacity per hour');
  const total = items.reduce((a, b) => a + b.eur, 0);
  const escProb = C.escalation.byClass[outcome] ?? 0;
  return {
    totalEur: total,
    items,
    downtimeH,
    escalationEur: escProb * C.escalation.catastrophicFurnaceEur,
    reportable: outcome === 'deflagration',
  };
}

/**
 * An operating reheat furnace loses money in four ways only: metal the mill will
 * not take, metal burned off as scale, gas burned above what the schedule should
 * have needed, and hours the mill sat waiting for slab. Nothing here is a
 * judgement about safety; the incident rows are repair and hold costs the plant
 * actually books.
 */
export function costFurnaceOperating(outcome: string, mag: Record<string, number>): CostBreakdown {
  const O = C.furnaceOperating;
  const items: CostBreakdown['items'] = [];
  const add = (label: string, eur: number, source: string) => {
    if (eur > 0.5) items.push({ label, eur, source });
  };
  let downtimeH = (mag.downtimeMin ?? 0) / 60;

  const scrap = mag.tonnesScrap ?? 0;
  const burnOff = mag.burnoffT ?? 0;
  const shortfall = mag.heatShortfallT ?? 0;
  const gasAbove = mag.gasAboveRefM3 ?? 0;

  if (scrap > 0) {
    add('Scrapped slab', scrap * O.scrapEurPerTonne, 'revert value of a reheated slab: metal, cast product and yard handling, net of scrap credit');
  }
  if (burnOff > 0) {
    add('Burn-off and scale loss', burnOff * O.burnOffEurPerTonne, 'lost yield valued at the hot-delivery price of the tonne the mill did not receive');
  }
  if (shortfall > 0) {
    add('Heat not delivered to the mill', shortfall * O.goodEurPerTonne, 'contribution margin per tonne of rolled product lost when the schedule misses its heat');
  }
  if (gasAbove > 0) {
    add('Gas above the scheduled specific energy', gasAbove * O.gasKwhPerM3 * O.gasEurPerKwh, 'industrial gas tariff at the meter, per kWh of net calorific value');
  }

  if (outcome === 'deflagration') {
    add('Chamber, burner blocks and lining rebuild', O.deflagrationRepairEur, 'rebuild after an internal deflagration in an operating reheat furnace');
    downtimeH += O.deflagrationHoldH;
  } else if (outcome === 'flame_out') {
    add('Burner train and chamber inspection after a blow-out', O.flameOutRepairEur, 'inspect, dry out and re-set the burners after combustion lifted off');
    downtimeH += O.flameOutHoldH;
  } else if (outcome === 'refractory_overtemp') {
    add('Roof panel cut-out and re-gun', O.refractoryRepairEur, 'refractory contractor rate for the patch a soak roof needs after an over-temperature excursion');
    downtimeH += O.refractoryHoldH;
  } else if (outcome === 'overheat_scrap' || outcome === 'refractory_damage' || outcome === 'shell_hotspot') {
    add('Ultrasonic lining survey and thermal monitoring', O.surveyFlatEur, 'NDT campaign on a lining that has been run above its design temperature');
    downtimeH += O.surveyHoldH;
  } else if (outcome === 'cold_slab_scrap' || outcome === 'scrap_batch') {
    add('Re-heat of the rejected charge and yard handling', O.reheatFlatEur, 'cost of returning rejected slab to the furnace or the yard and re-scheduling the heat');
    downtimeH += O.reheatHoldH;
  }

  if (downtimeH > 0) add('Line idle', downtimeH * O.lineIdleEurPerHour, 'contribution margin lost per hour the reheat furnace cannot feed the rolling mill');

  const total = items.reduce((a, b) => a + b.eur, 0);
  const escProb = C.escalation.byClass[outcome] ?? 0;
  return {
    totalEur: total,
    items,
    downtimeH,
    escalationEur: escProb * C.escalation.catastrophicFurnaceEur,
    // no reheat outcome is a release to the environment; a chamber that pops is
    // reported as damage and as an injury near-miss, not as a spill
    reportable: outcome === 'deflagration',
  };
}

export function costOf(twin: string, outcome: string, mag: Record<string, number>, product: string): CostBreakdown {
  if (twin === 'furnace_lightoff') return costFurnace(outcome, mag);
  if (twin === 'furnace_operating') return costFurnaceOperating(outcome, mag);
  return costTank(outcome, mag, product);
}

export const COST_META = C;
