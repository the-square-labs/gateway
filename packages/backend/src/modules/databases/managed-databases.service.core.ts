import crypto from 'node:crypto';
import { isIP } from 'node:net';
import type { DrizzleClient } from '@/db/client.js';
import type { ManagedRedisConfig } from '@/db/schema/databases.js';
import type { managedDatabaseInstances } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DatabaseCAService } from '@/services/database-ca.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DatabaseConnectionConfig } from './database-connection-view.js';
import type { DatabaseConnectionService } from './databases.service.js';

export const MEBIBYTE = 1024 * 1024;
export const GIBIBYTE = 1024 * MEBIBYTE;
export const CLICKHOUSE_QUERY_PRINCIPAL_VERSION = 1;
export const MANAGED_DATABASE_BINDING_IDENTITY_VERSION = 2;
export const logger = createChildLogger('ManagedDatabaseService');

export function storageSizeBytesFromGb(storageSizeGb: number): number {
  return Math.round(storageSizeGb * GIBIBYTE);
}

export const DEFAULT_MANAGED_REDIS_CONFIG: ManagedRedisConfig = {
  maxmemoryPercent: 75,
  maxmemoryPolicy: 'noeviction',
  appendOnly: true,
  appendFsync: 'everysec',
  rdbSnapshotsEnabled: true,
  rdbSaveSeconds: 3600,
  rdbSaveChanges: 1,
  autoAofRewritePercentage: 100,
  autoAofRewriteMinSizeMb: 64,
  maxclients: 10_000,
  timeoutSeconds: 0,
  tcpKeepaliveSeconds: 300,
  slowlogThresholdMicroseconds: 10_000,
  slowlogMaxLen: 128,
  activeDefrag: false,
};

export function managedRedisConfig(engineConfig: Record<string, unknown>): ManagedRedisConfig {
  const stored = engineConfig.redisConfig;
  return stored && typeof stored === 'object'
    ? { ...DEFAULT_MANAGED_REDIS_CONFIG, ...(stored as Partial<ManagedRedisConfig>) }
    : { ...DEFAULT_MANAGED_REDIS_CONFIG };
}

export const MANAGED_DATABASE_CATALOG = {
  postgres: {
    '18.4': 'docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a',
    '18.3': 'docker.io/library/postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db',
    '17.10': 'docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d',
    '17.8': 'docker.io/library/postgres@sha256:69dddb030ab69d669d8d7c6abf67aeb448178e5270d5f123a21f4f7ac8b46a24',
    '16.14': 'docker.io/library/postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20',
    '16.10': 'docker.io/library/postgres@sha256:21f6013073bc6b92830a2129570e2f5ec42a6c734b5a985a41e83aa58f54c3c1',
    '15.18': 'docker.io/library/postgres@sha256:74e110c41804365e3915fcc09d5e7a1eff50161aaa94d5da0e58e0cd75ae509c',
    '15.14': 'docker.io/library/postgres@sha256:822f8795764a670160640888508b2a68ea5c4b045012c2de17e1d0447bdbdc99',
    '14.23': 'docker.io/library/postgres@sha256:caf49e3b10d377aa2cfee478591d623808527beb27125d38797b418013f72d81',
    '14.19': 'docker.io/library/postgres@sha256:962ffbe9f6418387643411b127c1db27465e5a23b9a8849bfaf45fa6323963ce',
  },
  redis: {
    '8.10.0': 'docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236',
    '8.8.1': 'docker.io/library/redis@sha256:c88d347edef6249a6d2293f926f1eeb48bd40c57cbcd02c07f52e7f1fd2cb46b',
    '8.6.5': 'docker.io/library/redis@sha256:aefcda4d4388a70e628ad5ebbf162ae65509b20ea3dd6eeac7dcbbb675d94dba',
    '8.4.5': 'docker.io/library/redis@sha256:6159aff1adde991d8747d705fa1135ceda04b0414dc372b381a6af415ec3b374',
    '8.2.8': 'docker.io/library/redis@sha256:616bb446d5db225ddf786052834279e7c7222c48694d4451e8af22b8f5953b28',
    '7.4.10': 'docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b',
    '7.2.12': 'docker.io/library/redis@sha256:16623900b6ddd58e8bac04ccb6b611b9a5d1aed165453e28bcaed251d549d62c',
    '6.2.20': 'docker.io/library/redis@sha256:2a5e873bfae4bcc660b27f45c391d4a7a01799b65dea7286acc858e9c6c1e7d3',
  },
  clickhouse: {
    '26.7.1.1315':
      'docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5',
    '26.6.2.81':
      'docker.io/clickhouse/clickhouse-server@sha256:fdc22372465a336fa47e9deab61fad8277b9e2f2473234a1294b33b53f01d377',
    '26.5.6.64':
      'docker.io/clickhouse/clickhouse-server@sha256:0d16977194aca61e26631e616e0678c2a745344d7d9da5729d2356f413dd28e1',
    '26.4.5.143':
      'docker.io/clickhouse/clickhouse-server@sha256:ab3f33278b99576ea2ff2b0fa316b5e078c8b25f8ba08956cdbbb67d85c8b30f',
    '26.3.17.56':
      'docker.io/clickhouse/clickhouse-server@sha256:422be85ae7344058369cdd366ac0efea9daa8428b55c9cf50258e83a7d12fcb3',
    '25.8.28.1':
      'docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf',
    '25.3.8.23':
      'docker.io/clickhouse/clickhouse-server@sha256:0ab6e7c7597232b56c2883f67ef91154e7e3b54d1fda57606334aad65275e735',
    '24.8.14.39':
      'docker.io/clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b',
    '24.3.18.7':
      'docker.io/clickhouse/clickhouse-server@sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916',
  },
} as const;

export type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
export type ManagedDatabaseType = keyof typeof MANAGED_DATABASE_CATALOG;

export interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

export function managedDatabaseServiceAddresses(node: {
  serviceAddresses: string[];
  serviceAddress: string | null;
  lastHealthReport: unknown;
}): string[] {
  const health = node.lastHealthReport as
    | { localIpAddresses?: unknown; publicIpAddresses?: unknown }
    | null
    | undefined;
  const values = [
    ...node.serviceAddresses,
    ...(Array.isArray(health?.publicIpAddresses) ? health.publicIpAddresses : []),
    ...(Array.isArray(health?.localIpAddresses) ? health.localIpAddresses : []),
  ];
  return [
    ...new Set(
      values
        .filter((address): address is string => typeof address === 'string' && isIP(address.trim()) !== 0)
        .map((address) => address.trim())
    ),
  ];
}

export interface ManagedDatabaseRuntimeStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  swapUsageBytes: number;
  swapLimitBytes: number;
  pids: number;
}

export interface ManagedDatabaseLogTarget {
  managedDatabaseId: string;
  nodeId: string;
  containerId: string;
}

export interface ManagedDatabaseLogOptions {
  tailLines?: number;
  follow?: boolean;
  timestamps?: boolean;
  since?: string;
  until?: string;
}

export function runtimeValues(runtimeConfig: Record<string, unknown>) {
  return {
    memoryBytes: Number(runtimeConfig.memoryLimitBytes ?? 0),
    memorySwapBytes: Number(runtimeConfig.memorySwapBytes ?? 0),
    nanoCPUs: Number(runtimeConfig.nanoCPUs ?? 0),
    cpuShares: Number(runtimeConfig.cpuShares ?? 0),
    pidsLimit: Number(runtimeConfig.pidsLimit ?? 0),
  };
}

export function managedDatabasePublishTcp(row: ManagedDatabaseRow) {
  const engineConfig = row.engineConfig as unknown as Record<string, unknown>;
  return typeof engineConfig.publishTcp === 'boolean' ? engineConfig.publishTcp : row.publishedPort !== null;
}

export function managedDatabasePublishNativeTcp(row: ManagedDatabaseRow) {
  if (row.type !== 'clickhouse' || !managedDatabasePublishTcp(row)) return false;
  const engineConfig = row.engineConfig as unknown as Record<string, unknown>;
  return typeof engineConfig.publishNativeTcp === 'boolean'
    ? engineConfig.publishNativeTcp
    : row.publishedNativePort !== null;
}

export function bootstrapOwnerUsername(row: ManagedDatabaseRow) {
  const value = (row.engineConfig as unknown as Record<string, unknown>).ownerUsername;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export async function daemonCreateConfig(
  row: ManagedDatabaseRow,
  credentials: OwnerCredentials,
  publishTcp: boolean,
  publishNativeTcp: boolean,
  operationId: string,
  databaseCA?: DatabaseCAService
) {
  const engineConfig = row.engineConfig as unknown as Record<string, unknown>;
  const tls =
    databaseCA && row.certificateId ? await databaseCA.getManagedDatabaseCertificateMaterial(row.certificateId) : null;
  return {
    type: row.type,
    image: row.imageRef,
    storageSizeBytes: Number(row.storageSizeBytes),
    ...runtimeValues(row.runtimeConfig as unknown as Record<string, unknown>),
    operationId,
    ownerUsername: credentials.username,
    ownerPassword: credentials.password,
    // Redis does not have a database name, but the daemon still validates a
    // safe logical name so all commands have a uniform identity shape.
    databaseName: credentials.databaseName ?? 'redis',
    publishTcp,
    publishNativeTcp,
    publishedPort: row.publishedPort ?? 0,
    publishedNativePort: publishNativeTcp ? (row.publishedNativePort ?? 0) : 0,
    tlsEnabled: row.tlsEnabled,
    tlsCertificateId: row.tlsEnabled ? (row.certificateId ?? '') : '',
    ...(tls
      ? {
          tlsCertificatePem: tls.certificatePem,
          tlsPrivateKeyPem: tls.privateKeyPem,
          tlsCaCertificatePem: tls.caCertificatePem,
        }
      : {}),
    clickhouseConfigXml: typeof engineConfig.clickhouseConfigXml === 'string' ? engineConfig.clickhouseConfigXml : '',
    ...(row.type === 'redis' ? { redisConfig: managedRedisConfig(engineConfig) } : {}),
  };
}

export type ManagedDatabaseOperation = NonNullable<ManagedDatabaseRow['pendingOperation']>;

export interface DaemonManagedDatabaseState {
  status: 'ready' | 'paused' | 'stopped' | 'missing';
  operationId?: string;
}

export function daemonState(result: { detail?: string }): DaemonManagedDatabaseState | null {
  if (!result.detail) return null;
  try {
    const parsed = JSON.parse(result.detail) as { status?: unknown; operationId?: unknown };
    if (
      parsed.status !== 'ready' &&
      parsed.status !== 'paused' &&
      parsed.status !== 'stopped' &&
      parsed.status !== 'missing'
    )
      return null;
    return {
      status: parsed.status,
      ...(typeof parsed.operationId === 'string' ? { operationId: parsed.operationId } : {}),
    };
  } catch {
    return null;
  }
}

export function catalogImage(type: ManagedDatabaseType, version: string): string {
  const image = MANAGED_DATABASE_CATALOG[type][version as never];
  if (!image) throw new AppError(400, 'INVALID_MANAGED_DATABASE_VERSION', 'Unsupported managed database version');
  return image;
}

export function safeManagedDatabaseView(row: ManagedDatabaseRow) {
  const runtime = runtimeValues(row.runtimeConfig as unknown as Record<string, unknown>);
  return {
    id: row.id,
    databaseConnectionId: row.databaseConnectionId,
    nodeId: row.nodeId,
    name: row.name,
    slug: row.slug,
    type: row.type,
    version: row.version,
    storageSizeBytes: row.storageSizeBytes,
    runtimeConfig: {
      cpuCores: runtime.nanoCPUs / 1_000_000_000,
      memoryMb: Math.round(runtime.memoryBytes / MEBIBYTE),
      swapMb: Math.max(0, Math.round((runtime.memorySwapBytes - runtime.memoryBytes) / MEBIBYTE)),
    },
    publishedPort: row.publishedPort,
    publishedNativePort: row.publishedNativePort,
    tlsEnabled: row.tlsEnabled,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function managedConnectionConfig(
  type: ManagedDatabaseRow['type'],
  credentials: OwnerCredentials,
  tlsEnabled = false
): DatabaseConnectionConfig {
  if (type === 'postgres') {
    return {
      type,
      host: 'managed.gateway.internal',
      port: 5432,
      database: credentials.databaseName ?? 'app',
      username: credentials.username,
      password: credentials.password,
      sslEnabled: tlsEnabled,
    };
  }
  if (type === 'clickhouse') {
    return {
      type,
      url: 'http://managed.gateway.internal:8123',
      host: 'managed.gateway.internal',
      port: 8123,
      database: credentials.databaseName ?? 'app',
      username: credentials.username,
      password: credentials.password,
      tlsEnabled: false,
    };
  }
  return {
    type,
    host: 'managed.gateway.internal',
    port: 6379,
    username: credentials.username,
    password: credentials.password,
    db: 0,
    tlsEnabled: false,
  };
}

export function newDirectAccessCredentials(type: ManagedDatabaseRow['type'], databaseName?: string): OwnerCredentials {
  return {
    username: `gw_${type}_direct_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    password: crypto.randomBytes(32).toString('base64url'),
    ...(type === 'redis' ? {} : { databaseName: databaseName ?? 'app' }),
  };
}

export function newClickHouseQueryCredentials(databaseName?: string): OwnerCredentials {
  return {
    username: `gw_clickhouse_query_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    password: crypto.randomBytes(32).toString('base64url'),
    databaseName: databaseName ?? 'app',
  };
}

export function stableManagedDatabasePrincipal(prefix: string, id: string) {
  return `${prefix}_${id.replaceAll('-', '').slice(0, 24)}`;
}

export function applicationPrincipalName(row: ManagedDatabaseRow) {
  if (row.type === 'redis') return 'default';
  return stableManagedDatabasePrincipal('gw_app', row.id);
}

export function newPostgresControlCredentials(row: ManagedDatabaseRow, owner: OwnerCredentials): OwnerCredentials {
  return {
    username: stableManagedDatabasePrincipal('gw_admin', row.id),
    password: crypto.randomBytes(32).toString('base64url'),
    databaseName: owner.databaseName ?? 'app',
  };
}

export function newOwnerRotationCredentials(owner: OwnerCredentials): OwnerCredentials {
  return {
    username: owner.username,
    password: crypto.randomBytes(32).toString('base64url'),
    databaseName: owner.databaseName ?? 'app',
  };
}

export function parseEncryptedCredentials(value: string): { encryptedKey: string; encryptedDek: string } {
  try {
    const parsed = JSON.parse(value) as { encryptedKey?: string; encryptedDek?: string };
    if (typeof parsed.encryptedKey === 'string' && typeof parsed.encryptedDek === 'string')
      return parsed as {
        encryptedKey: string;
        encryptedDek: string;
      };
  } catch {
    // Fall through to the generic corruption error below.
  }
  throw new AppError(500, 'MANAGED_DATABASE_CREDENTIALS_CORRUPT', 'Managed database credentials are unavailable');
}

export function validateClickHouseFragment(value: string | undefined) {
  if (!value) return;
  if (
    /<\/?(?:path|tmp_path|user_files_path|listen_host|interserver_http_host|http_port|tcp_port|https_port)\b/i.test(
      value
    )
  ) {
    throw new AppError(
      400,
      'INVALID_CLICKHOUSE_CONFIG',
      'ClickHouse config cannot override managed paths or network settings'
    );
  }
}

export function allocatedPort(
  result: { detail?: string },
  field: 'publishedPort' | 'publishedNativePort'
): number | null {
  if (!result.detail) return null;
  try {
    const parsed = JSON.parse(result.detail) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  } catch {
    return null;
  }
}

export function allocatedPublishedPort(result: { detail?: string }): number | null {
  return allocatedPort(result, 'publishedPort');
}

export function allocatedPublishedNativePort(result: { detail?: string }): number | null {
  return allocatedPort(result, 'publishedNativePort');
}

export function parseManagedRuntimeStats(result: { detail?: string }): ManagedDatabaseRuntimeStats | null {
  if (!result.detail) return null;
  try {
    const parsed = JSON.parse(result.detail) as Record<string, unknown>;
    if (parsed.status !== 'ready') return null;
    const numeric = (key: string) => {
      const value = Number(parsed[key]);
      return Number.isFinite(value) ? value : 0;
    };
    return {
      cpuPercent: numeric('cpuPercent'),
      memoryUsageBytes: numeric('memoryUsageBytes'),
      memoryLimitBytes: numeric('memoryLimitBytes'),
      swapUsageBytes: numeric('swapUsageBytes'),
      swapLimitBytes: numeric('swapLimitBytes'),
      pids: numeric('pids'),
    };
  } catch {
    return null;
  }
}

export abstract class ManagedDatabaseServiceCore {
  protected licensePolicy?: LicensePolicyService;
  protected eventBus?: EventBusService;
  protected reconciliationInFlight = false;
  protected readonly bindingIdentityReconciliationNodes = new Set<string>();
  protected readonly bindingIdentityOperations = new Map<string, Promise<void>>();
  protected readonly databaseOperationDispatches = new Map<string, Promise<unknown>>();

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly auditService: AuditService,
    protected readonly cryptoService: CryptoService,
    protected readonly nodeDispatch: NodeDispatchService,
    protected readonly databaseCA?: DatabaseCAService,
    protected readonly databaseConnectionService?: DatabaseConnectionService
  ) {}

  setLicensePolicyService(service: LicensePolicyService): void {
    this.licensePolicy = service;
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
    bus.subscribe('node.changed', (payload) => {
      const event = payload as { id?: unknown; status?: unknown } | null;
      if (typeof event?.id !== 'string' || event.status !== 'online') return;
      this.reconcileBindingIdentitiesForNode(event.id).catch((error) => {
        logger.warn('Failed to reconcile managed database identities after daemon connect', {
          nodeId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }

  protected abstract reconcileBindingIdentitiesForNode(nodeId: string): Promise<void>;

  protected emit(
    row: Pick<ManagedDatabaseRow, 'id' | 'databaseConnectionId' | 'name' | 'type' | 'status'>,
    action: string
  ) {
    this.eventBus?.publish('database.changed', {
      resourceKind: 'managed_database',
      id: row.databaseConnectionId ?? row.id,
      managedDatabaseId: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      action,
    });
  }
}
