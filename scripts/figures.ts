import { runBatch } from '../src/engine/batch';
import { runRepairLoop } from '../src/lib/fuzz';
import { DEFAULT_CONFIG, PERSONAS, PLANTS, PROCEDURES, buildRunConfig } from '../src/lib/registry';
import type { ConsoleConfig } from '../src/lib/registry';

/**
 * The figures the write-up, the title cards and the narration quote.
 *
 * `smoke.ts` sweeps the whole model with its own seeds, which is the right tool
 * for spotting a row that has drifted out of a believable range but the wrong
 * tool for a number somebody else has to be able to see on screen. This script
 * runs the console's own default configuration - same seed, same shift count -
 * so every figure printed here is what the deployed application shows when those
 * two dropdowns are set that way and Run is pressed once.
 */
const N = Number(process.argv[2] ?? DEFAULT_CONFIG.n);
const withRepair = process.argv.includes('--repair');

function run(personaId: string, plantId: string) {
  const cfg: ConsoleConfig = { ...DEFAULT_CONFIG, personaId, plantId, n: N };
  const s = runBatch(buildRunConfig(cfg), N).summary;
  const top = Object.entries(s.perStep)
    .filter(([, v]) => v.causalFailure > 0)
    .sort((a, b) => b[1].causalFailure - a[1].causalFailure)
    .slice(0, 2)
    .map(([id, v]) => `${id} ${(v.p * 100).toFixed(1)}%`)
    .join('  ');
  const outcomes = Object.entries(s.outcomeCounts)
    .filter(([k]) => k !== 'normal')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${k} ${((v / N) * 100).toFixed(1)}%`)
    .join(', ');
  return {
    fail: (s.failureRate * 100).toFixed(2),
    mean: Math.round(s.meanCostEur).toLocaleString('en-US'),
    annual: Math.round(s.annualLossEur).toLocaleString('en-US'),
    outcomes,
    top,
  };
}

const GRID: [string, string[]][] = [
  ['tk_asdesigned', ['daytime_competent', 'night_trainee']],
  ['tk_after_instrument_work', ['daytime_competent', 'night_trainee']],
  ['tk_uprated', ['daytime_competent', 'night_trainee']],
];

console.log(`# canonical figures - ${PROCEDURES[0].id}, seed ${DEFAULT_CONFIG.seed}, method SPAR-H, ${N} shifts\n`);
for (const [plantId, crews] of GRID) {
  const plant = PLANTS.find((p) => p.id === plantId)!;
  console.log(`${plantId} - ${plant.label}`);
  for (const crew of crews) {
    const r = run(crew, plantId);
    const label = PERSONAS.find((p) => p.id === crew)!.label;
    console.log(`  ${label.padEnd(30)} ${r.fail}% lost   EUR ${r.annual}/yr   ${r.outcomes}   [${r.top}]`);
  }
  console.log('');
}

if (withRepair) {
  const cfg: ConsoleConfig = {
    ...DEFAULT_CONFIG, personaId: 'night_trainee', plantId: 'tk_after_instrument_work', n: N,
  };
  void runRepairLoop(cfg, N, () => {}).then((result) => {
    const accepted = result.trials.filter((t) => t.verdict?.accepted);
    console.log('repair loop on night_trainee / tk_after_instrument_work');
    console.log(`  baseline ${(result.baseline.failureRate * 100).toFixed(2)}%`);
    console.log(`  ${result.trials.length} candidates, ${accepted.length} accepted`);
    for (const t of accepted) {
      console.log(`    + ${t.control.id.padEnd(24)} ${(t.summary!.failureRate * 100).toFixed(2)}%  net EUR ${Math.round(t.verdict!.netEur).toLocaleString('en-US')}/yr`);
    }
    if (result.stacked) {
      const v = result.stacked.verdict;
      console.log(`  stacked [${result.stacked.controls.join(', ')}] -> ${(result.stacked.summary.failureRate * 100).toFixed(2)}%`
        + (v ? `  net EUR ${Math.round(v.netEur).toLocaleString('en-US')}/yr` : ''));
    }
  });
}
