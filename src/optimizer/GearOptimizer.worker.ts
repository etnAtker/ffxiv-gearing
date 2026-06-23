import { optimizeGearset } from './GearOptimizer';
import type { GearOptimizationWorkerRequest, GearOptimizationWorkerResponse } from './GearOptimizerTypes';

const ctx: Worker = globalThis as any;

ctx.onmessage = (event: MessageEvent<GearOptimizationWorkerRequest>) => {
  if (event.data.type !== 'optimize') return;
  try {
    const report = optimizeGearset(event.data.input, event.data.config, progress => {
      ctx.postMessage({ type: 'progress', progress } satisfies GearOptimizationWorkerResponse);
    });
    ctx.postMessage({ type: 'result', report } satisfies GearOptimizationWorkerResponse);
  } catch (e) {
    ctx.postMessage({
      type: 'error',
      error: e instanceof Error ? e.message : String(e),
    } satisfies GearOptimizationWorkerResponse);
  }
};
