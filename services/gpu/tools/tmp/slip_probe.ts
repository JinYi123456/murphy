import proc from '../../../../data/procedures/OP-TRF-014.json';
import personasRaw from '../../../../data/personas.json';
import plantsRaw from '../../../../data/plants.json';
import { conditionsFor } from '../../../../src/engine/runner';
const p = proc as any; const persona = (personasRaw as any[]).find(x => x.id === 'daytime_competent');
const plant = (plantsRaw as any[]).find(x => x.id === 'tk_after_instrument_work');
const step = p.steps.find((s: any) => s.id === 'd14');
for (const slip of [1.0, 1.06, 1.3, 2.07]) {
  const c = conditionsFor(step, persona, plant, { slipRatio: slip, alarmRinging: false, hazardSeen: false,
    setup: { permitLeftSomethingIsolated: false, instrumentDrift: 0, driveDegraded: 1, protectionFailedOnDemand: false } });
  console.log(slip, JSON.stringify(Object.keys(c)), 'time_pressure=', (c as any).time_pressure);
}
