import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('RuntimeRestart');

export class RuntimeRestartService {
  request(reason: string, delayMs = 500): void {
    logger.info('Gateway restart requested', { reason, delayMs });
    const timer = setTimeout(() => process.kill(process.pid, 'SIGTERM'), delayMs);
    timer.unref();
  }
}
