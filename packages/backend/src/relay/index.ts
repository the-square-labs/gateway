import { createChildLogger } from '@/lib/logger.js';
import { loadRelayConfig } from './config.js';
import { startStandaloneRelay } from './server.js';

const logger = createChildLogger('GatewayRelayEntrypoint');

async function main(): Promise<void> {
  const runtime = await startStandaloneRelay(loadRelayConfig());
  const stop = () => {
    void runtime.stop().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error) => {
  logger.error('Gateway relay failed to start', {
    error:
      error instanceof Error
        ? error.message.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgres://[redacted]@')
        : 'unknown',
  });
  process.exit(1);
});
