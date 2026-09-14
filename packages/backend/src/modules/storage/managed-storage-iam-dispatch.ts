import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { type ManagedStorageClusterRow, nodes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { StorageCAService } from '@/services/storage-ca.service.js';

export interface StorageIamDispatchOpts {
  publishedPort: number;
  useTls: boolean;
  caPem?: string;
  serverName?: string;
  rootAccessKey: string;
  rootSecretKey: string;
}

/**
 * Coordinates for reaching one cluster's MinIO admin API.
 *
 * Shared by the cluster service (operator-managed access keys) and the binding
 * service (per-binding scoped keys) so both speak to the admin API with the
 * same TLS identity rules — a divergence here surfaces as a TLS verification
 * failure only on whichever path was not updated.
 */
export async function resolveStorageIamDispatchOpts(
  db: DrizzleClient,
  row: ManagedStorageClusterRow,
  credentials: { username: string; password: string },
  storageCA?: StorageCAService
): Promise<StorageIamDispatchOpts> {
  const useTls = row.tlsEnabled;
  let caPem: string | undefined;
  let serverName: string | undefined;
  if (useTls) {
    if (!storageCA) {
      throw new AppError(500, 'MANAGED_STORAGE_TLS_CA_UNAVAILABLE', 'Storage CA is not configured');
    }
    const ca = await storageCA.getStorageCA();
    caPem = ca.certificatePem;
    const [node] = await db
      .select({ hostname: nodes.hostname, serviceAddress: nodes.serviceAddress })
      .from(nodes)
      .where(eq(nodes.id, row.nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Managed storage node not found');
    // Pin the same identity the S3 endpoint uses (serviceAddress ?? hostname),
    // not hostname alone: both are covered by the cluster cert's SANs, so this
    // matches whichever the operator configured. hostname-only would fail
    // madmin TLS verification on a node whose serviceAddress is an IP.
    serverName = node.serviceAddress ?? node.hostname ?? undefined;
  }
  return {
    publishedPort: row.publishedPort,
    useTls,
    caPem,
    serverName,
    rootAccessKey: credentials.username,
    rootSecretKey: credentials.password,
  };
}
