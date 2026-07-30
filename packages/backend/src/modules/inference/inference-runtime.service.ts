import { injectable } from 'tsyringe';
import { AppError } from '@/middleware/error-handler.js';
import type {
  InferenceExecution,
  InferenceExecutionContext,
  InferenceExecutor,
  InferenceRequest,
} from './protocol/inference-protocol.types.js';

@injectable()
export class InferenceRuntimeService {
  private executor: InferenceExecutor | null = null;

  setExecutor(executor: InferenceExecutor): void {
    this.executor = executor;
  }

  isConfigured(): boolean {
    return this.executor !== null;
  }

  execute(request: InferenceRequest, context: InferenceExecutionContext): Promise<InferenceExecution> {
    if (!this.executor) {
      throw new AppError(
        503,
        'INFERENCE_NOT_CONFIGURED',
        'Inference is not configured yet; connect and publish a model first'
      );
    }
    return this.executor.execute(request, context);
  }
}
