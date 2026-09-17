import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
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
export class StorageWorkloadProvider implements ManagedWorkloadProvider {
  declare readonly kind: 'storage';
  // biome-ignore lint/complexity/noUselessConstructor: Stable commercial constructor contract.
  constructor(_db: DrizzleClient, _cryptoService: CryptoService, _storageCA?: StorageCAService | undefined) {}
  setEventBus(_bus: EventBusService): void {}
  resolveImage(_type: string, _version: string): string {
    return commercialModuleUnavailable();
  }
  listCatalog(): ManagedWorkloadCatalogEntry[] {
    return commercialModuleUnavailable();
  }
  async registerCanonicalConnection(_ctx: CanonicalConnectionContext): Promise<string> {
    return commercialModuleUnavailable();
  }
  async syncCanonicalConnection(_ctx: CanonicalConnectionSyncContext): Promise<void> {
    return commercialModuleUnavailable();
  }
  async ensureCertificate(_ctx: CertificateContext): Promise<CertificateResult | null> {
    return commercialModuleUnavailable();
  }
}
