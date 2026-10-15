import { NextResponse } from 'next/server';
import { writeErrorScenario } from '../../../../lib/llm/agents';
import { DEFAULT_CONFIG, personaById, plantById, procedureById } from '../../../../lib/registry';
import type { ErrorKind, PersonaTraits, PlantConfig, Step } from '../../../../engine/types';

export const runtime = 'nodejs';

interface ScenarioRequest {
  step?: Step;
  stepId?: string;
  procedureId?: string;
  persona?: PersonaTraits;
  personaId?: string;
  plant?: PlantConfig;
  plantId?: string;
  kind?: ErrorKind;
}

/**
 * Write one error mode for one step.
 *
 * A step, a crew and a configuration are taken by id wherever possible so the
 * scenario is authored against the same objects the fuzz run uses; inline objects
 * are accepted for a draft that has never been registered. `unresolved` in the
 * answer is deliberate: a variable the model named but nobody has given a value
 * is shown as an open item instead of being quietly dropped.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ScenarioRequest | null;
  if (!body) return NextResponse.json({ error: 'a step, persona and plant are required', llm: { used: false, reason: 'no body' } }, { status: 400 });

  let step = body.step;
  let persona = body.persona;
  let plant = body.plant;
  try {
    if (!step && body.stepId) step = procedureById(body.procedureId ?? DEFAULT_CONFIG.procedureId).steps.find((s) => s.id === body.stepId);
    if (!persona) persona = personaById(body.personaId ?? DEFAULT_CONFIG.personaId);
    if (!plant) plant = plantById(body.plantId ?? DEFAULT_CONFIG.plantId);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, llm: { used: false, reason: 'unknown id' } }, { status: 400 });
  }

  if (!step || !persona || !plant) {
    return NextResponse.json(
      { error: 'step (or stepId), persona (or personaId) and plant (or plantId) are required', llm: { used: false, reason: 'incomplete request' } },
      { status: 400 },
    );
  }

  const { result, llm } = await writeErrorScenario(step, persona, plant, body.kind);
  return NextResponse.json({ ...result, llm });
}
