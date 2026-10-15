/**
 * Twin interface.
 *
 * Every twin is written as a single scalar step function operating on an
 * offset into a flat Float64Array. Three consequences matter:
 *
 *  1. The batched runner and the trace replay call literally the same
 *     function, so a scenario replayed inside a different batch size gives
 *     the same trajectory.
 *  2. The state update uses only + - * /, comparisons and clamping. No
 *     transcendental call appears in the physics, so IEEE-754 double
 *     arithmetic gives identical trajectories on CPU, GPU and in the browser.
 *     The PyTorch engine mirrors these files line for line and tests/ holds
 *     both implementations to the same seeds.
 *  3. The runner never names a physical quantity. It reaches the process
 *     through `iface`, which is what lets one kernel drive a liquid transfer
 *     and a furnace heat-up without either being special-cased.
 *
 * Randomness is deliberately absent from the physics. The process model is
 * deterministic; the uncertainty lives in human action, equipment
 * configuration and instrument health, sampled at discrete decision points.
 * That is cheaper, and it is a more honest statement of where procedural risk
 * actually comes from.
 */

export interface TwinParams {
  [k: string]: number;
}

export interface TwinConfig {
  /** fill / charge fraction at start, expressed against the danger threshold */
  startLevelFrac: number;
  /** protective functions in place at shift start */
  protection: Record<string, boolean>;
  /** protective device proven within the test interval */
  provenRecent: boolean;
  /** instruments that a maintenance permit has left isolated at shift start */
  preIsolated: string[];
  /** additive error present on the local indicator */
  indicatorBias: number;
  /** feedstock/product key into the cost table */
  product: string;
  extra?: Record<string, number>;
}

/**
 * Named handles the runner uses. `progress` is whatever the procedure is
 * trying to achieve, `hazard` is nonzero once anything has actually been
 * released or damaged, and `alarm` latches when the first annunciator fires.
 */
export interface TwinIface {
  progress: string;
  /** params key holding the completion value for progress */
  target: string;
  /** params key holding the nominal rate of achieving progress, per second */
  rate: string;
  runFlag: string;
  stopFlag: string;
  alarm: string;
  hazard: string;
  clock: string;
  /** scenario-vector keys the runner may write; absent keys are ignored */
  bias?: string;
  scale?: string;
  failOnDemand?: string;
}

export interface TwinDef {
  id: string;
  label: string;
  unit: string;
  hazardKind: string;
  /** continuous state names; index order is the wire format for both engines */
  vars: string[];
  /** scenario state names (flags and per-scenario parameters) */
  discs: string[];
  params: TwinParams;
  iface: TwinIface;
  /** units and display labels for the series plot */
  display: Record<string, { label: string; unit: string; danger?: number }>;

  init(s: Float64Array, so: number, d: Float64Array, doff: number, p: TwinParams, cfg: TwinConfig): void;
  advance(s: Float64Array, so: number, d: Float64Array, doff: number, p: TwinParams, dtS: number): void;
  /** what the operator's indicator actually reads */
  indication(s: Float64Array, so: number, d: Float64Array, doff: number, name: string): number;
  /** physical magnitudes; the economics model turns these into money */
  magnitudes(s: Float64Array, so: number, d: Float64Array, doff: number): Record<string, number>;
  classify(s: Float64Array, so: number, d: Float64Array, doff: number, p: TwinParams): string;
  /** one-sentence hazard statement for the shift record */
  hazardNote(s: Float64Array, so: number, d: Float64Array, doff: number, p: TwinParams): string;
  varIndex(name: string): number;
  discIndex(name: string): number;
}
