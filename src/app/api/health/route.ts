import { NextResponse } from 'next/server';
import { gpuHealth } from '../../../lib/gpu';
import { llmStatus } from '../../../lib/llm/client';
import { listTwins } from '../../../engine/twins/index';
import { HRA_METHODS } from '../../../engine/hra';
import { CONDITION_LABELS } from '../../../engine/conditions';
import { CONTROL_CATALOGUE } from '../../../lib/registry';
import { PROCEDURES, PERSONAS, PLANTS } from '../../../lib/registry';
import { inspectModel } from '../../../engine/model';

export const runtime = 'nodejs';

/**
 * Everything the interface needs to describe itself honestly: which engines are
 * attached, which are simulated locally, and what the model actually contains.
 * Presence of credentials is reported; their values never are.
 */
export async function GET() {
  const [gpu, llm] = await Promise.all([gpuHealth(), Promise.resolve(llmStatus())]);
  return NextResponse.json({
    backends: {
      amd: gpu,
      llm,
      evolus: { configured: Boolean(process.env.EVOLUS_API_KEY && process.env.EVOLUS_APP_ID) },
    },
    model: {
      procedures: PROCEDURES.map((p) => ({
        id: p.id,
        title: p.title,
        revision: p.revision,
        twin: p.twin,
        steps: p.steps.length,
        integrity: inspectModel(p).ok,
        warnings: p.warnings?.length ?? 0,
      })),
      twins: listTwins().map((t) => ({ id: t.id, label: t.label, unit: t.unit, hazardKind: t.hazardKind, vars: t.vars, discs: t.discs, params: t.params })),
      personas: PERSONAS.map((p) => ({ id: p.id, label: p.label, notes: p.notes })),
      plants: PLANTS.map((p) => ({ id: p.id, label: p.label, twin: p.twin, notes: p.notes })),
      methods: HRA_METHODS,
      conditions: CONDITION_LABELS,
      controls: CONTROL_CATALOGUE.map((c) => ({ id: c.id, label: c.label, tier: c.tier, annualCostEur: c.effect.annualCostEur ?? 0 })),
    },
    version: { engine: 1, schema: 'murphy-1' },
  });
}
