import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { managedStorageClusters } from '@/db/schema/managed-storage.js';
import { objectStorageConnections } from '@/db/schema/object-storage.js';
import { grantCreatedResourcePermissions } from '@/lib/created-resource-permissions.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type {
  CanonicalConnectionContext,
  CanonicalConnectionSyncContext,
  CertificateContext,
  CertificateResult,
  ManagedWorkloadCatalogEntry,
  ManagedWorkloadProvider,
} from '@/modules/managed-workloads/managed-workload-provider.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';
import { managedStorageServiceAddresses } from './managed-storage.service.js';
import { MANAGED_STORAGE_CATALOG, type ManagedStorageType } from './managed-storage-catalog.js';

/**
 * Storage-specific implementation of the `ManagedWorkloadProvider` seam:
 * curated image catalog resolution and canonical `object_storage_connections`
 * registration/sync, plus TLS certificate issuance from the internal Storage
 * CA, for managed object storage (MinIO). Mirrors `DatabaseWorkloadProvider`'s
 * structure (see `modules/databases/database-workload-provider.ts`),
 * including the optional CA constructor arg (undefined = TLS disabled).
 * Cert delivery/HTTPS serving is deferred to Phase 2b-ii-B — this only issues
 * and persists the certificate.
 */
export class StorageWorkloadProvider implements ManagedWorkloadProvider {
  readonly kind = 'storage' as const;

  private eventBus?: EventBusService;

  constructor(
    private readonly db: DrizzleClient,
    private readonly cryptoService: CryptoService,
    private readonly storageCA?: StorageCAService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  resolveImage(type: string, version: string): string {
    const image = MANAGED_STORAGE_CATALOG[type as ManagedStorageType]?.[version as never];
    if (!image) {
      throw new AppError(400, 'INVALID_MANAGED_STORAGE_VERSION', `Unknown managed storage version: ${type} ${version}`);
    }
    return image;
  }

  listCatalog(): ManagedWorkloadCatalogEntry[] {
    return [{ type: 'minio', versions: Object.keys(MANAGED_STORAGE_CATALOG.minio) }];
  }

  async registerCanonicalConnection(ctx: CanonicalConnectionContext): Promise<string> {
    if (!ctx.storage) {
      throw new AppError(
        500,
        'MANAGED_STORAGE_REGISTRATION_INVALID',
        'registerCanonicalConnection requires ctx.storage for the storage provider'
      );
    }
    const storage = ctx.storage;
    // Matches ObjectStorageService.encryptSecret's `{secretAccessKey}` shape,
    // which the object browser's decrypt path expects.
    const encryptedConfig = JSON.stringify(
      this.cryptoService.encryptString(JSON.stringify({ secretAccessKey: ctx.credentials.password }))
    );
    const connection = await writeWithAllocatedSlug({
      source: ctx.name,
      fallback: 'storage',
      constraint: 'object_storage_connections_slug_unique',
      write: async (slug) => {
        const [created] = await this.db
          .insert(objectStorageConnections)
          .values({
            name: ctx.name,
            slug,
            provider: storage.s3Provider,
            origin: 'managed',
            tags: ctx.tags ?? [],
            endpoint: storage.endpoint,
            region: storage.region,
            accessKeyId: ctx.credentials.username,
            forcePathStyle: storage.forcePathStyle,
            encryptedConfig,
            createdById: ctx.userId,
            updatedById: ctx.userId,
          })
          .returning();
        return created!;
      },
    });
    // Match ObjectStorageService.emitChange so the object-browser sidebar shows
    // the managed connection live instead of only after a manual refresh.
    await grantCreatedResourcePermissions(ctx.userId, 'storage', connection.id);
    this.eventBus?.publish('storage.changed', { id: connection.id, action: 'created' });
    return connection.id;
  }

  async syncCanonicalConnection(ctx: CanonicalConnectionSyncContext): Promise<void> {
    if (!ctx.connectionId) return;

    if (ctx.previousName !== undefined) {
      if (ctx.name === ctx.previousName) return;
      const [connection] = await this.db
        .select()
        .from(objectStorageConnections)
        .where(eq(objectStorageConnections.id, ctx.connectionId))
        .limit(1);
      if (!connection) return;
      const update = async (slug?: string) => {
        const [updated] = await this.db
          .update(objectStorageConnections)
          .set({ name: ctx.name, updatedById: ctx.updatedById, updatedAt: new Date(), ...(slug ? { slug } : {}) })
          .where(eq(objectStorageConnections.id, connection.id))
          .returning();
        return updated!;
      };
      const updated = await writeWithAllocatedSlug({
        source: ctx.name,
        fallback: 'storage',
        constraint: 'object_storage_connections_slug_unique',
        write: update,
      });
      // Match ObjectStorageService.emitChange's channel + payload so the
      // existing frontend subscribers (SidebarContent cache invalidation,
      // StorageDetail rename-redirect on oldSlug/slug) fire on managed-storage
      // renames too.
      this.eventBus?.publish('storage.changed', {
        id: updated.id,
        action: 'updated',
        name: updated.name,
        provider: updated.provider,
        healthStatus: updated.healthStatus,
        ...(updated.slug === connection.slug ? {} : { oldSlug: connection.slug, slug: updated.slug }),
      });
      return;
    }

    if (ctx.storage?.endpoint !== undefined) {
      await this.db
        .update(objectStorageConnections)
        .set({ endpoint: ctx.storage.endpoint, updatedById: ctx.updatedById, updatedAt: new Date() })
        .where(eq(objectStorageConnections.id, ctx.connectionId));
      this.eventBus?.publish('storage.changed', { id: ctx.connectionId, action: 'updated' });
      return;
    }

    if (ctx.tags !== undefined) {
      await this.db
        .update(objectStorageConnections)
        .set({ tags: ctx.tags, updatedById: ctx.updatedById, updatedAt: new Date() })
        .where(eq(objectStorageConnections.id, ctx.connectionId));
      this.eventBus?.publish('storage.changed', { id: ctx.connectionId, action: 'updated' });
    }
  }

  async ensureCertificate(ctx: CertificateContext): Promise<CertificateResult | null> {
    if (ctx.existingCertificateId || !this.storageCA) return null;
    const addresses = [
      ...new Set([...managedStorageServiceAddresses(ctx.node, ctx.relay ?? false), ...(ctx.additionalAddresses ?? [])]),
    ];
    if (addresses.length === 0) {
      throw new AppError(
        409,
        'MANAGED_STORAGE_TLS_IDENTITY_UNAVAILABLE',
        'Managed storage node has no configured IP addresses for TLS'
      );
    }
    const issued = await this.storageCA.issueManagedStorageCertificate(
      ctx.workloadId,
      addresses,
      async (tx, certificate) => {
        await tx
          .update(managedStorageClusters)
          .set({ certificateId: certificate.id, tlsEnabled: true })
          .where(eq(managedStorageClusters.id, ctx.workloadId));
      }
    );
    return { certificateId: issued.certificate.id };
  }
}
