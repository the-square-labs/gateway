import type { DrizzleClient } from '@/db/client.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import type { PageRetentionService } from './page-retention.service.js';
export class PageMaintenanceService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _store: PageArtifactStore,
    _retentionService: PageRetentionService,
    _eventBus: EventBusService
  ) {}
  setMigrationReconciler(_reconciler: { reconcileMigrations(): Promise<number> }): void {}
  async run(): Promise<{
    itemsCleaned: number;
    spaceFreedBytes: number;
  }> {
    return { itemsCleaned: 0, spaceFreedBytes: 0 };
  }
}
