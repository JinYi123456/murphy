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

export function costOf(twin: string, outcome: string, mag: Record<string, number>, product: string): CostBreakdown {
  if (twin === 'furnace_lightoff') return costFurnace(outcome, mag);
  return costTank(outcome, mag, product);
}

export const COST_META = C;
