import type { TwinDef } from './twin';
import { tankTwin } from './tank';
import { furnaceTwin } from './furnace';
import { furnaceOpsTwin } from './furnaceOps';

const REGISTRY: Record<string, TwinDef> = {
  [tankTwin.id]: tankTwin,
  [furnaceTwin.id]: furnaceTwin,
  [furnaceOpsTwin.id]: furnaceOpsTwin,
};

export function getTwin(id: string): TwinDef {
  const t = REGISTRY[id];
  if (!t) throw new Error(`unknown twin "${id}"`);
  return t;
}

export function listTwins(): TwinDef[] {
  return Object.values(REGISTRY);
}

export type { TwinDef, TwinConfig, TwinParams } from './twin';
