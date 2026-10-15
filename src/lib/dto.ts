import type { BatchSummary, StepStat } from '../engine/batch';
import type { ExtendedResult, StepAudit } from '../engine/runner';
import type { HraMethod } from '../engine/hra';

/** Plain-JSON projections of engine objects; typed arrays do not cross a wire. */

export interface StepStatDto extends Omit<StepStat, never> {}

export interface SummaryDto {
  variantId: string;
  seed: string;
  n: number;
  failed: number;
  failureRate: number;
  nearMissRate: number;
  outcomeCounts: Record<string, number>;
  perStep: Record<string, StepStatDto>;
  meanCostEur: number;
  costCi: { mean: number; ciLow: number; ciHigh: number };
  p95CostEur: number;
  cvarCostEur: number;
  meanReleaseM3: number;
  meanElapsedS: number;
  meanHazardS: number;
  shiftsPerYear: number;
  annualLossEur: number;
  annualEscalatedEur: number;
  wallMs: number;
  shiftsPerSecond: number;
  worst: number[];
}

export interface TraceEventDto {
  tS: number;
  kind: string;
  stepId?: string;
  label: string;
  detail?: string;
  vars?: Record<string, number | string>;
}

export interface ShiftDto {
  scn: number;
  outcome: string;
  failed: boolean;
  nearMiss: boolean;
  note: string;
  method: HraMethod;
  errors: ExtendedResult['errors'];
  caughtBy: Record<string, string>;
  peak: Record<string, number>;
  elapsedS: number;
  hazardSeconds: number;
  scheduleSlip: number;
  trace: TraceEventDto[];
  series: ExtendedResult['series'];
  audit: StepAudit[];
}

export interface RunEnvelope {
  summary: SummaryDto;
  traced: ShiftDto[];
  /** which engine answered, shown to the user, never faked */
  source: 'browser' | 'node' | 'amd';
  device?: string;
  ms: number;
}

export function toSummaryDto(s: BatchSummary): SummaryDto {
  return {
    variantId: s.variantId, seed: s.seed, n: s.n, failed: s.failed, failureRate: s.failureRate,
    nearMissRate: s.nearMissRate, outcomeCounts: s.outcomeCounts, perStep: s.perStep,
    meanCostEur: s.meanCostEur, costCi: s.costCi, p95CostEur: s.p95CostEur, cvarCostEur: s.cvarCostEur,
    meanReleaseM3: s.meanReleaseM3, meanElapsedS: s.meanElapsedS, meanHazardS: s.meanHazardS,
    shiftsPerYear: s.shiftsPerYear, annualLossEur: s.annualLossEur, annualEscalatedEur: s.annualEscalatedEur,
    wallMs: s.wallMs, shiftsPerSecond: s.shiftsPerSecond, worst: s.worst,
  };
}

export function toShiftDto(r: ExtendedResult): ShiftDto {
  return {
    scn: r.scn, outcome: r.outcome, failed: r.failed, nearMiss: r.nearMiss, note: r.note,
    method: r.method, errors: r.errors, caughtBy: r.caughtBy, peak: r.peak,
    elapsedS: r.elapsedS, hazardSeconds: r.hazardSeconds, scheduleSlip: r.scheduleSlip,
    trace: r.trace, series: r.series, audit: r.audit,
  };
}
