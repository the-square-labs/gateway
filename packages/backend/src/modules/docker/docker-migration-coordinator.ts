import type { DrizzleClient } from '@/db/client.js';
import type { dockerMigrations } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { ProxyService } from '@/modules/proxy/proxy.service.js';
import type { RelayRegistryService } from '@/services/relay-registry.service.js';
import type { DockerAccessResourceService } from './docker-access-resource.service.js';
import type { DockerSnapshotReconciler } from './docker-snapshot-reconciler.service.js';

type MigrationRow = typeof dockerMigrations.$inferSelect;
export class DockerMigrationCoordinator {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _proxy: ProxyService,
    _snapshots: DockerSnapshotReconciler,
    _accessResources: DockerAccessResourceService,
    _registry?: RelayRegistryService | undefined
  ) {}
  async enterMaintenance(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cutoverMetadata(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async refreshTargetSnapshots(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async refreshSourceSnapshots(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
  async exitEnteredMaintenance(_row: MigrationRow): Promise<void> {
    return commercialModuleUnavailable();
  }
}
