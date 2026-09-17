import type { DockerService } from '@/services/docker.service.js';
import type { LoggingRuntimeSettings } from './logging-settings.service.js';
export class LocalClickHouseService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_docker: DockerService) {}
  async reconcile(_config: LoggingRuntimeSettings): Promise<void> {}
}
