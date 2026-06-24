import type { GearOptimizationConfig, GearOptimizationInput, GearOptimizationProgress,
  GearOptimizationReport, GearOptimizationWorkerRequest, GearOptimizationWorkerResponse } from './GearOptimizerTypes';

export interface GearOptimizationRunner {
  cancel: () => void,
}

export function runGearOptimizationInWorker(args: {
  input: GearOptimizationInput,
  config: GearOptimizationConfig,
  onProgress: (progress: GearOptimizationProgress) => void,
  onResult: (report: GearOptimizationReport) => void,
  onError: (error: string) => void,
}): GearOptimizationRunner {
  const worker = new Worker(new URL('./GearOptimizer.worker.ts', import.meta.url));
  worker.onmessage = (event: MessageEvent<GearOptimizationWorkerResponse>) => {
    switch (event.data.type) {
      case 'progress':
        args.onProgress(event.data.progress);
        break;
      case 'result':
        worker.terminate();
        args.onResult(event.data.report);
        break;
      case 'error':
        worker.terminate();
        args.onError(event.data.error);
        break;
    }
  };
  worker.onerror = event => {
    worker.terminate();
    args.onError(event.message);
  };
  worker.postMessage({
    type: 'optimize',
    input: args.input,
    config: args.config,
  } satisfies GearOptimizationWorkerRequest);
  return {
    cancel: () => worker.terminate(),
  };
}
