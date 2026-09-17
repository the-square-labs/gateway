import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { ManagedStorageMetrics } from './managed-storage-metrics.js';

export class ManagedStorageMetricsProvider {
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(_db: DrizzleClient) {}
  async getMetrics(_clusterId: string): Promise<ManagedStorageMetrics | null> {
    return commercialModuleUnavailable();
  }
  async getSnapshot(_clusterId: string): Promise<{ timestamp: string | null; metrics: ManagedStorageMetrics } | null> {
    return commercialModuleUnavailable();
  }
}
