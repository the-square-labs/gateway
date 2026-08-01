import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { databaseConnections, managedDatabaseBindings, managedDatabaseInstances, nodes } from '@/db/schema/index.js';
import { writeWithAllocatedSlug } from '@/lib/resource-slugs.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { DatabaseCAService } from '@/services/database-ca.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { DatabaseConnectionConfig } from './database-connection-view.js';
import type {
  CreateManagedDatabaseInput,
  ManagedDatabaseListQuery,
  UpdateManagedDatabaseInput,
} from './databases.schemas.js';

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

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

type ManagedDatabaseRow = typeof managedDatabaseInstances.$inferSelect;
type ManagedDatabaseType = keyof typeof MANAGED_DATABASE_CATALOG;

interface OwnerCredentials {
  username: string;
  password: string;
  databaseName?: string;
}

function managedDatabaseServiceAddresses(node: { serviceAddress: string | null; lastHealthReport: unknown }): string[] {
  const health = node.lastHealthReport as
    | { localIpAddresses?: unknown; publicIpAddresses?: unknown }
    | null
    | undefined;
  const values = [
    node.serviceAddress,
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

function runtimeValues(runtimeConfig: Record<string, unknown>) {
  return {
    memoryBytes: Number(runtimeConfig.memoryLimitBytes ?? 0),
    memorySwapBytes: Number(runtimeConfig.memorySwapBytes ?? 0),
    nanoCPUs: Number(runtimeConfig.nanoCPUs ?? 0),
    cpuShares: Number(runtimeConfig.cpuShares ?? 0),
    pidsLimit: Number(runtimeConfig.pidsLimit ?? 0),
  };
}

function managedDatabasePublishTcp(row: ManagedDatabaseRow) {
  const engineConfig = row.engineConfig as unknown as Record<string, unknown>;
  return typeof engineConfig.publishTcp === 'boolean' ? engineConfig.publishTcp : row.publishedPort !== null;
}

function managedDatabasePublishNativeTcp(row: ManagedDatabaseRow) {
  if (row.type !== 'clickhouse' || !managedDatabasePublishTcp(row)) return false;
  const engineConfig = row.engineConfig as unknown as Record<string, unknown>;
  return typeof engineConfig.publishNativeTcp === 'boolean'
    ? engineConfig.publishNativeTcp
    : row.publishedNativePort !== null;
}

async function daemonCreateConfig(
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
  };
}

type ManagedDatabaseOperation = NonNullable<ManagedDatabaseRow['pendingOperation']>;

interface DaemonManagedDatabaseState {
  status: 'ready' | 'paused' | 'stopped' | 'missing';
  operationId?: string;
}

function daemonState(result: { detail?: string }): DaemonManagedDatabaseState | null {
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

function catalogImage(type: ManagedDatabaseType, version: string): string {
  const image = MANAGED_DATABASE_CATALOG[type][version as never];
  if (!image) throw new AppError(400, 'INVALID_MANAGED_DATABASE_VERSION', 'Unsupported managed database version');
  return image;
}

function safeManagedDatabaseView(row: ManagedDatabaseRow) {
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

function managedConnectionConfig(
  type: ManagedDatabaseRow['type'],
  credentials: OwnerCredentials
): DatabaseConnectionConfig {
  if (type === 'postgres') {
    return {
      type,
      host: 'managed.gateway.internal',
      port: 5432,
      database: credentials.databaseName ?? 'app',
      username: credentials.username,
      password: credentials.password,
      sslEnabled: false,
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

function newDirectAccessCredentials(type: ManagedDatabaseRow['type'], databaseName?: string): OwnerCredentials {
  return {
    username: `gw_${type}_direct_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
    password: crypto.randomBytes(32).toString('base64url'),
    ...(type === 'redis' ? {} : { databaseName: databaseName ?? 'app' }),
  };
}

function parseEncryptedCredentials(value: string): { encryptedKey: string; encryptedDek: string } {
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

function validateClickHouseFragment(value: string | undefined) {
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

function allocatedPort(result: { detail?: string }, field: 'publishedPort' | 'publishedNativePort'): number | null {
  if (!result.detail) return null;
  try {
    const parsed = JSON.parse(result.detail) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  } catch {
    return null;
  }
}

function allocatedPublishedPort(result: { detail?: string }): number | null {
  return allocatedPort(result, 'publishedPort');
}

function allocatedPublishedNativePort(result: { detail?: string }): number | null {
  return allocatedPort(result, 'publishedNativePort');
}

function parseManagedRuntimeStats(result: { detail?: string }): ManagedDatabaseRuntimeStats | null {
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

export class ManagedDatabaseService {
  private eventBus?: EventBusService;
  private reconciliationInFlight = false;

  constructor(
    private readonly db: DrizzleClient,
    private readonly auditService: AuditService,
    private readonly cryptoService: CryptoService,
    private readonly nodeDispatch: NodeDispatchService,
    private readonly databaseCA?: DatabaseCAService
  ) {}

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  listCatalog() {
    return Object.entries(MANAGED_DATABASE_CATALOG).map(([type, versions]) => ({
      type,
      versions: Object.keys(versions),
    }));
  }

  async list(query: ManagedDatabaseListQuery = {}) {
    const conditions = [];
    if (query.nodeId) conditions.push(eq(managedDatabaseInstances.nodeId, query.nodeId));
    if (query.type) conditions.push(eq(managedDatabaseInstances.type, query.type));
    const rows = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(managedDatabaseInstances.name));
    return rows.map(safeManagedDatabaseView);
  }

  async get(id: string) {
    return safeManagedDatabaseView(await this.getRow(id));
  }

  async getByDatabaseConnectionId(databaseConnectionId: string) {
    const [row] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    return row ? safeManagedDatabaseView(row) : null;
  }

  /**
   * Older installations may already have lifecycle records. Backfill their
   * canonical database resource without touching the running container or its
   * storage volume.
   */
  async reconcileDatabaseConnections() {
    const rows = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(isNull(managedDatabaseInstances.databaseConnectionId));
    for (const row of rows) {
      if (row.databaseConnectionId) continue;
      const credentials = JSON.parse(
        this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
      ) as OwnerCredentials;
      const connection = await this.createCanonicalConnection(
        row.name,
        row.type,
        credentials,
        row.storageSizeBytes,
        row.createdById
      );
      await this.db
        .update(managedDatabaseInstances)
        .set({ databaseConnectionId: connection.id, updatedAt: new Date() })
        .where(eq(managedDatabaseInstances.id, row.id));
      this.emit({ ...row, databaseConnectionId: connection.id }, 'connection.backfilled');
    }
  }

  /** Backfill certificates for instances created before direct TLS existed. */
  async reconcileDatabaseCertificates() {
    if (!this.databaseCA) return;
    const rows = await this.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        certificateId: managedDatabaseInstances.certificateId,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(managedDatabaseInstances)
      .innerJoin(nodes, eq(nodes.id, managedDatabaseInstances.nodeId))
      .where(isNull(managedDatabaseInstances.certificateId));
    for (const row of rows) {
      const serviceAddresses = managedDatabaseServiceAddresses(row);
      if (serviceAddresses.length === 0) continue;
      const issued = await this.databaseCA.issueManagedDatabaseCertificate(row.id, serviceAddresses);
      await this.db
        .update(managedDatabaseInstances)
        .set({ certificateId: issued.certificate.id, updatedAt: new Date() })
        .where(and(eq(managedDatabaseInstances.id, row.id), isNull(managedDatabaseInstances.certificateId)));
    }
  }

  async create(input: CreateManagedDatabaseInput, userId: string) {
    validateClickHouseFragment(input.clickhouseConfigXml);
    const imageRef = catalogImage(input.type, input.version);
    const node = await this.assertDatabaseNode(input.nodeId);
    const credentials: OwnerCredentials = {
      // Redis `requirepass` configures Redis's built-in `default` ACL user.
      // Retaining an invented username here would make revealed direct
      // credentials unusable, so its owner identity is deliberately fixed.
      username: input.type === 'redis' ? 'default' : (input.ownerUsername ?? `${input.type}_owner`),
      password: crypto.randomBytes(32).toString('base64url'),
      ...(input.type === 'redis' ? {} : { databaseName: input.databaseName ?? 'app' }),
    };
    const encryptedOwnerCredentials = JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials)));
    const directCredentials = newDirectAccessCredentials(input.type, credentials.databaseName);
    const encryptedDirectCredentials = JSON.stringify(
      this.cryptoService.encryptString(JSON.stringify(directCredentials))
    );
    const runtimeConfig = {
      nanoCPUs: Math.round(input.cpuCores * 1_000_000_000),
      memoryLimitBytes: input.memoryMb * MEBIBYTE,
      memorySwapBytes: (input.memoryMb + input.swapMb) * MEBIBYTE,
    };
    const publishNativeTcp = input.publishTcp && input.type === 'clickhouse' && input.publishNativeTcp !== false;
    const engineConfig = {
      ownerUsername: credentials.username,
      publishTcp: input.publishTcp,
      ...(input.type === 'clickhouse' ? { publishNativeTcp } : {}),
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      ...(input.clickhouseConfigXml ? { clickhouseConfigXml: input.clickhouseConfigXml } : {}),
    };
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'create' };
    const connection = await this.createCanonicalConnection(
      input.name,
      input.type,
      directCredentials,
      input.storageSizeGb * GIBIBYTE,
      userId
    );
    let row: ManagedDatabaseRow;
    try {
      row = await writeWithAllocatedSlug({
        source: input.name,
        fallback: 'managed-database',
        constraint: 'managed_database_instances_slug_unique',
        write: async (slug) => {
          const [created] = await this.db
            .insert(managedDatabaseInstances)
            .values({
              databaseConnectionId: connection.id,
              nodeId: input.nodeId,
              name: input.name,
              slug,
              type: input.type,
              version: input.version,
              imageRef,
              engineConfig,
              encryptedOwnerCredentials,
              encryptedDirectCredentials,
              storageSizeBytes: input.storageSizeGb * GIBIBYTE,
              runtimeConfig,
              tlsEnabled: input.tlsEnabled,
              publishedPort: input.publishTcp ? (input.publishedPort ?? null) : null,
              publishedNativePort: publishNativeTcp ? (input.publishedNativePort ?? null) : null,
              status: 'creating',
              pendingOperation,
              createdById: userId,
              updatedById: userId,
            })
            .returning();
          return created!;
        },
      });
    } catch (error) {
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, connection.id));
      throw error;
    }
    try {
      row = await this.ensureManagedDatabaseCertificate(row, node);
    } catch (error) {
      await this.db.delete(managedDatabaseInstances).where(eq(managedDatabaseInstances.id, row.id));
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, connection.id));
      throw error;
    }
    this.emit(row, 'created');
    await this.auditService.log({
      userId,
      action: 'database.managed.create',
      resourceType: 'managed_database',
      resourceId: row.id,
      details: { name: row.name, type: row.type, version: row.version, nodeId: row.nodeId },
    });

    return this.dispatchCreate(row, credentials, input.publishTcp, publishNativeTcp, userId);
  }

  async update(id: string, input: UpdateManagedDatabaseInput, userId: string) {
    validateClickHouseFragment(input.clickhouseConfigXml);
    let existing = await this.getRow(id);
    if (existing.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    if (existing.status === 'paused') {
      throw new AppError(409, 'MANAGED_DATABASE_PAUSED', 'Unpause the managed database before changing its settings');
    }
    if (input.storageSizeGb !== undefined && input.storageSizeGb * GIBIBYTE < Number(existing.storageSizeBytes)) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_STORAGE_REDUCTION_UNSUPPORTED',
        'Managed database storage can only be increased'
      );
    }
    const node = await this.assertDatabaseNode(existing.nodeId);
    existing = await this.ensureManagedDatabaseCertificate(existing, node);
    const nextPublishTcp = input.publishTcp ?? existing.publishedPort !== null;
    if (input.publishNativeTcp !== undefined && existing.type !== 'clickhouse') {
      throw new AppError(
        400,
        'MANAGED_DATABASE_NATIVE_PUBLICATION_UNSUPPORTED',
        'Only ClickHouse has a native TCP endpoint'
      );
    }
    if (input.publishNativeTcp && !nextPublishTcp) {
      throw new AppError(
        400,
        'MANAGED_DATABASE_NATIVE_PUBLICATION_REQUIRES_TCP',
        'Publish the ClickHouse TCP endpoint before publishing its native endpoint'
      );
    }
    const nextPublishedPort =
      input.publishTcp === false
        ? null
        : input.publishedPort === undefined
          ? existing.publishedPort
          : input.publishedPort;
    const nextPublishNativeTcp =
      nextPublishTcp &&
      existing.type === 'clickhouse' &&
      (input.publishNativeTcp ?? existing.publishedNativePort !== null);
    const nextPublishedNativePort = !nextPublishNativeTcp
      ? null
      : input.publishedNativePort === undefined
        ? existing.publishedNativePort
        : input.publishedNativePort;
    const next = {
      name: input.name ?? existing.name,
      storageSizeBytes: input.storageSizeGb === undefined ? existing.storageSizeBytes : input.storageSizeGb * GIBIBYTE,
      runtimeConfig: {
        ...existing.runtimeConfig,
        ...(input.cpuCores === undefined ? {} : { nanoCPUs: Math.round(input.cpuCores * 1_000_000_000) }),
        ...(input.memoryMb === undefined ? {} : { memoryLimitBytes: input.memoryMb * MEBIBYTE }),
        ...(input.memoryMb === undefined && input.swapMb === undefined
          ? {}
          : {
              memorySwapBytes:
                ((input.memoryMb ?? Math.round((existing.runtimeConfig.memoryLimitBytes ?? 0) / MEBIBYTE)) +
                  (input.swapMb ??
                    Math.max(
                      0,
                      Math.round(
                        ((existing.runtimeConfig.memorySwapBytes ?? existing.runtimeConfig.memoryLimitBytes ?? 0) -
                          (existing.runtimeConfig.memoryLimitBytes ?? 0)) /
                          MEBIBYTE
                      )
                    ))) *
                MEBIBYTE,
            }),
      },
      tlsEnabled: input.tlsEnabled ?? existing.tlsEnabled,
      publishedPort: nextPublishedPort,
      publishedNativePort: nextPublishedNativePort,
      engineConfig: {
        ...existing.engineConfig,
        publishTcp: nextPublishTcp,
        ...(existing.type === 'clickhouse' ? { publishNativeTcp: nextPublishNativeTcp } : {}),
        ...(input.clickhouseConfigXml === undefined ? {} : { clickhouseConfigXml: input.clickhouseConfigXml }),
      },
    };
    const existingCredentials = JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(existing.encryptedOwnerCredentials))
    ) as OwnerCredentials;
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'update' };
    const [updating] = await this.db
      .update(managedDatabaseInstances)
      .set({
        ...next,
        updatedById: userId,
        updatedAt: new Date(),
        status: 'updating',
        pendingOperation,
        lastError: null,
      })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    await this.syncCanonicalConnectionName(updating!, existing.name);
    await this.syncCanonicalConnectionTags(updating!, input.tags);
    return this.dispatchUpdate(updating!, existingCredentials, nextPublishTcp, nextPublishNativeTcp, userId);
  }

  async rotateCertificate(id: string, userId: string) {
    const existing = await this.getRow(id);
    if (existing.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    if (existing.status === 'paused') {
      throw new AppError(
        409,
        'MANAGED_DATABASE_PAUSED',
        'Unpause the managed database before rotating its certificate'
      );
    }
    if (!this.databaseCA) {
      throw new AppError(503, 'MANAGED_DATABASE_TLS_UNAVAILABLE', 'Managed database TLS is not available');
    }
    const node = await this.assertDatabaseNode(existing.nodeId);
    const serviceAddresses = managedDatabaseServiceAddresses(node);
    if (serviceAddresses.length === 0) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_TLS_IDENTITY_UNAVAILABLE',
        'Database node has no service IP addresses available for the managed TLS certificate'
      );
    }
    const issued = await this.databaseCA.issueManagedDatabaseCertificate(existing.id, serviceAddresses);
    const credentials = JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(existing.encryptedOwnerCredentials))
    ) as OwnerCredentials;
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'update' };
    const [updating] = await this.db
      .update(managedDatabaseInstances)
      .set({
        certificateId: issued.certificate.id,
        status: 'updating',
        pendingOperation,
        lastError: null,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, existing.id))
      .returning();
    await this.auditService.log({
      userId,
      action: 'database.managed.tls_certificate.rotate',
      resourceType: 'managed_database',
      resourceId: existing.id,
      details: { name: existing.name, type: existing.type, serviceAddresses },
    });
    this.emit(updating!, 'tls_certificate.rotating');
    return this.dispatchUpdate(
      updating!,
      credentials,
      managedDatabasePublishTcp(updating!),
      managedDatabasePublishNativeTcp(updating!),
      userId
    );
  }

  async pause(id: string, userId: string) {
    return this.beginLifecycleTransition(id, userId, 'pause', 'ready', 'paused');
  }

  async unpause(id: string, userId: string) {
    return this.beginLifecycleTransition(id, userId, 'unpause', 'paused', 'ready');
  }

  async delete(id: string, userId: string) {
    const row = await this.getRow(id);
    if (row.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    await this.assertDatabaseNode(row.nodeId);
    const [binding] = await this.db
      .select({ id: managedDatabaseBindings.id })
      .from(managedDatabaseBindings)
      .where(eq(managedDatabaseBindings.managedDatabaseId, id))
      .limit(1);
    if (binding) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_BINDINGS_EXIST',
        'Delete managed database bindings before deleting the database'
      );
    }
    const [deleting] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status: 'deleting',
        pendingOperation: { id: crypto.randomUUID(), action: 'delete' },
        lastError: null,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    return this.dispatchDelete(deleting!, userId);
  }

  async retryProvisioning(id: string, userId: string) {
    let row = await this.getRow(id);
    if (row.status !== 'error' || row.lastError !== 'Managed database create failed') {
      throw new AppError(
        409,
        'MANAGED_DATABASE_NOT_RETRYABLE',
        'Only a failed managed database deployment can be retried'
      );
    }
    const node = await this.assertDatabaseNode(row.nodeId);
    row = await this.ensureManagedDatabaseCertificate(row, node);
    const credentials = JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
    ) as OwnerCredentials;
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action: 'create' };
    const [retrying] = await this.db
      .update(managedDatabaseInstances)
      .set({ status: 'creating', pendingOperation, lastError: null, updatedById: userId, updatedAt: new Date() })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    await this.auditService.log({
      userId,
      action: 'database.managed.retry_provisioning',
      resourceType: 'managed_database',
      resourceId: id,
      details: { name: retrying!.name, type: retrying!.type, nodeId: retrying!.nodeId },
    });
    this.emit(retrying!, 'retrying');
    return this.dispatchCreate(
      retrying!,
      credentials,
      managedDatabasePublishTcp(retrying!),
      managedDatabasePublishNativeTcp(retrying!),
      userId
    );
  }

  async revealCredentials(id: string) {
    const row = await this.getRow(id);
    if (row.publishedPort === null) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_NOT_PUBLISHED',
        'Publish a TCP port before revealing direct-access credentials'
      );
    }
    // Direct credentials are persisted encrypted at creation time. Revealing
    // an existing account must be local-only; re-running binding_create here
    // would add a daemon round trip to every UI reveal. The lifecycle and
    // reconciliation paths already re-apply the principal after recreation.
    const existing = this.directAccessCredentials(row);
    const { row: current, credentials } = existing
      ? { row, credentials: existing }
      : await this.ensureDirectAccessCredentials(row, null);
    const ca = row.tlsEnabled && this.databaseCA ? await this.databaseCA.getDatabaseCA() : null;
    return {
      username: credentials.username,
      password: credentials.password,
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      publishedPort: current.publishedPort,
      publishedNativePort: current.publishedNativePort,
      tlsEnabled: current.tlsEnabled,
      ...(ca
        ? {
            caCertificate: ca.certificatePem,
            caFingerprint: crypto.createHash('sha256').update(ca.certificatePem).digest('hex'),
          }
        : {}),
    };
  }

  async rotateDirectAccessCredentials(id: string, userId: string) {
    const row = await this.getRow(id);
    if (row.publishedPort === null) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_NOT_PUBLISHED',
        'Publish a TCP port before rotating direct-access credentials'
      );
    }
    if (row.status !== 'ready' || row.pendingOperation) {
      throw new AppError(409, 'MANAGED_DATABASE_NOT_READY', 'Managed database is not ready for credential rotation');
    }
    await this.assertDatabaseNode(row.nodeId);
    const owner = this.ownerCredentials(row);
    const current = this.directAccessCredentials(row) ?? newDirectAccessCredentials(row.type, owner.databaseName);
    const credentials = { ...current, password: crypto.randomBytes(32).toString('base64url') };
    await this.provisionDirectAccessPrincipal(row, owner, credentials);
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({
        encryptedDirectCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials))),
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    await this.syncCanonicalConnectionCredentials(updated!, credentials, userId);
    await this.auditService.log({
      userId,
      action: 'database.managed.direct_access.rotate',
      resourceType: 'managed_database',
      resourceId: id,
      details: { name: updated!.name, type: updated!.type },
    });
    this.emit(updated!, 'direct_access.rotated');
    return {
      username: credentials.username,
      password: credentials.password,
      ...(credentials.databaseName ? { databaseName: credentials.databaseName } : {}),
      publishedPort: updated!.publishedPort,
    };
  }

  /**
   * Managed runtime accounting is observational. A missing sample must not
   * change the engine health result, so callers get null when it is not ready.
   */
  async getRuntimeStatsByDatabaseConnectionId(
    databaseConnectionId: string
  ): Promise<ManagedDatabaseRuntimeStats | null> {
    const [row] = await this.db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        status: managedDatabaseInstances.status,
      })
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.databaseConnectionId, databaseConnectionId))
      .limit(1);
    if (!row || row.status !== 'ready') return null;
    const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'stats', row.id, '', 10_000);
    return result.success ? parseManagedRuntimeStats(result) : null;
  }

  /** Reconcile unknown outcomes after reconnects or controller delivery failures. */
  async reconcilePendingOperations() {
    if (this.reconciliationInFlight) return;
    this.reconciliationInFlight = true;
    try {
      const rows = await this.db
        .select()
        .from(managedDatabaseInstances)
        .where(isNotNull(managedDatabaseInstances.pendingOperation));
      for (const row of rows) await this.reconcilePendingRow(row);
    } finally {
      this.reconciliationInFlight = false;
    }
  }

  private async dispatchCreate(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'create');
    const direct = await this.ensureDirectAccessCredentials(row, userId, false);
    const configJson = JSON.stringify(
      await daemonCreateConfig(row, credentials, publishTcp, publishNativeTcp, operation.id, this.databaseCA)
    );
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'create', row.id, configJson);
      if (!result.success) return this.markError(row, 'create');
      await this.provisionDirectAccessPrincipal(direct.row, credentials, direct.credentials);
      const publishedPort = await this.resolvePublishedPort(direct.row, publishTcp, result);
      const publishedNativePort = await this.resolvePublishedNativePort(direct.row, publishNativeTcp, result);
      return this.markReady(direct.row, userId, publishedPort, 'ready', publishedNativePort);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  private async dispatchUpdate(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    publishTcp: boolean,
    publishNativeTcp: boolean,
    userId: string | null
  ) {
    const operation = this.pendingOperation(row, 'update');
    const direct = await this.ensureDirectAccessCredentials(row, userId, false);
    const configJson = JSON.stringify(
      await daemonCreateConfig(row, credentials, publishTcp, publishNativeTcp, operation.id, this.databaseCA)
    );
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'update', row.id, configJson);
      if (!result.success) return this.markError(row, 'update');
      await this.provisionDirectAccessPrincipal(direct.row, credentials, direct.credentials);
      const publishedPort = await this.resolvePublishedPort(direct.row, publishTcp, result);
      const publishedNativePort = await this.resolvePublishedNativePort(direct.row, publishNativeTcp, result);
      const [ready] = await this.db
        .update(managedDatabaseInstances)
        .set({
          status: 'ready',
          pendingOperation: null,
          lastError: null,
          publishedPort,
          publishedNativePort,
          updatedById: userId,
          updatedAt: new Date(),
        })
        .where(eq(managedDatabaseInstances.id, direct.row.id))
        .returning();
      await this.syncCanonicalConnectionStorageLimit(ready!);
      await this.auditService.log({
        userId,
        action: 'database.managed.update',
        resourceType: 'managed_database',
        resourceId: row.id,
        details: { name: ready!.name, type: ready!.type },
      });
      this.emit(ready!, 'ready');
      return safeManagedDatabaseView(ready!);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  private async dispatchDelete(row: ManagedDatabaseRow, userId: string | null) {
    this.pendingOperation(row, 'delete');
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        'remove',
        row.id,
        JSON.stringify({ operationId: row.pendingOperation!.id })
      );
      if (!result.success) return this.markError(row, 'delete');
    } catch {
      return this.markOutcomeUnknown(row);
    }
    await this.completeDelete(row, userId);
    return { success: true };
  }

  private async reconcilePendingRow(row: ManagedDatabaseRow) {
    const operation = row.pendingOperation;
    if (!operation) return;
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
      if (!result.success) return;
      const state = daemonState(result);
      if (!state) return;
      if (state.status === 'missing' && operation.action === 'delete') {
        return this.completeDelete(row, null);
      }
      // Daemon commands are handled asynchronously. An inspect can acquire
      // the database mutex before an earlier mutation, so missing or stale
      // operation IDs are not a terminal outcome. Replay the *same* durable
      // operation ID instead: create/update are idempotent on it and remove
      // is idempotent for a missing record.
      if (state.status === 'missing' || state.operationId !== operation.id) {
        await this.replayPendingOperation(row);
        return;
      }
      if (operation.action === 'delete') {
        await this.dispatchDelete(row, null);
        return;
      }
      if (operation.action === 'pause' || operation.action === 'unpause') {
        const expectedStatus = operation.action === 'pause' ? 'paused' : 'ready';
        if (state.status !== expectedStatus) {
          await this.replayPendingOperation(row);
          return;
        }
        await this.completeLifecycleTransition(row, null, expectedStatus, operation.action);
        return;
      }
      if (state.status === 'paused') {
        await this.replayPendingOperation(row);
        return;
      }
      // A create/update may have reached Docker before the controller lost its
      // response. Re-apply the direct principal before clearing the durable
      // operation so the database never becomes "ready" without its
      // published-TCP credentials being usable.
      const direct = await this.ensureDirectAccessCredentials(row, null);
      // Inspect is also the recovery source of truth for an auto-assigned
      // host port when the original create/update response was lost.
      await this.markReady(direct.row, null, allocatedPublishedPort(result) ?? row.publishedPort, state.status);
    } catch {
      // The node is offline or the inspect response is still unavailable.
      // Keep the durable pending operation for the next scheduled pass.
    }
  }

  private async replayPendingOperation(row: ManagedDatabaseRow) {
    if (this.databaseCA) {
      const node = await this.assertDatabaseNode(row.nodeId);
      row = await this.ensureManagedDatabaseCertificate(row, node);
    }
    const operation = this.pendingOperation(row, row.pendingOperation!.action);
    if (operation.action === 'delete') return this.dispatchDelete(row, null);
    if (operation.action === 'pause' || operation.action === 'unpause') {
      return this.dispatchLifecycleTransition(
        row,
        null,
        operation.action,
        operation.action === 'pause' ? 'paused' : 'ready'
      );
    }
    const credentials = JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
    ) as OwnerCredentials;
    if (operation.action === 'create') {
      return this.dispatchCreate(
        row,
        credentials,
        managedDatabasePublishTcp(row),
        managedDatabasePublishNativeTcp(row),
        null
      );
    }
    return this.dispatchUpdate(
      row,
      credentials,
      managedDatabasePublishTcp(row),
      managedDatabasePublishNativeTcp(row),
      null
    );
  }

  private pendingOperation(row: ManagedDatabaseRow, action: ManagedDatabaseOperation['action']) {
    if (!row.pendingOperation || row.pendingOperation.action !== action) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation does not match its pending state'
      );
    }
    return row.pendingOperation;
  }

  private async beginLifecycleTransition(
    id: string,
    userId: string,
    action: 'pause' | 'unpause',
    requiredStatus: 'ready' | 'paused',
    targetStatus: 'ready' | 'paused'
  ) {
    const row = await this.getRow(id);
    if (row.pendingOperation) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_OPERATION_PENDING',
        'Managed database operation is still being reconciled'
      );
    }
    if (row.status !== requiredStatus) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_INVALID_LIFECYCLE_STATE',
        `Managed database must be ${requiredStatus} before it can be ${targetStatus}`
      );
    }
    await this.assertDatabaseNode(row.nodeId);
    const pendingOperation: ManagedDatabaseOperation = { id: crypto.randomUUID(), action };
    const [pending] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status: 'updating',
        pendingOperation,
        lastError: null,
        updatedById: userId,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, id))
      .returning();
    this.emit(pending!, `${action}.started`);
    return this.dispatchLifecycleTransition(pending!, userId, action, targetStatus);
  }

  private async dispatchLifecycleTransition(
    row: ManagedDatabaseRow,
    userId: string | null,
    action: 'pause' | 'unpause',
    targetStatus: 'ready' | 'paused'
  ) {
    const operation = this.pendingOperation(row, action);
    try {
      const result = await this.nodeDispatch.sendDockerDatabaseCommand(
        row.nodeId,
        action,
        row.id,
        JSON.stringify({ operationId: operation.id })
      );
      if (!result.success) return this.markError(row, action);
      const state = daemonState(result);
      if (!state || state.status !== targetStatus || state.operationId !== operation.id) {
        return this.markOutcomeUnknown(row);
      }
      return this.completeLifecycleTransition(row, userId, targetStatus, action);
    } catch {
      return this.markOutcomeUnknown(row);
    }
  }

  private async completeLifecycleTransition(
    row: ManagedDatabaseRow,
    userId: string | null,
    status: 'ready' | 'paused',
    action: 'pause' | 'unpause'
  ) {
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status,
        pendingOperation: null,
        lastError: null,
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    if (userId) {
      await this.auditService.log({
        userId,
        action: `database.managed.${action}`,
        resourceType: 'managed_database',
        resourceId: row.id,
        details: { name: updated!.name, type: updated!.type },
      });
    }
    this.emit(updated!, status);
    return safeManagedDatabaseView(updated!);
  }

  private async markReady(
    row: ManagedDatabaseRow,
    userId: string | null,
    publishedPort: number | null,
    status: 'ready' | 'stopped' = 'ready',
    publishedNativePort: number | null = row.publishedNativePort
  ) {
    const [ready] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status,
        pendingOperation: null,
        lastError: null,
        publishedPort,
        publishedNativePort,
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    this.emit(ready!, status);
    return safeManagedDatabaseView(ready!);
  }

  private async markOutcomeUnknown(row: ManagedDatabaseRow) {
    const [pending] = await this.db
      .update(managedDatabaseInstances)
      .set({ lastError: 'Managed database operation outcome is being reconciled', updatedAt: new Date() })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    this.emit(pending!, 'reconciling');
    return safeManagedDatabaseView(pending!);
  }

  private async markError(row: ManagedDatabaseRow, operation: ManagedDatabaseOperation['action']) {
    const [failed] = await this.db
      .update(managedDatabaseInstances)
      .set({
        status: 'error',
        pendingOperation: null,
        lastError: `Managed database ${operation} failed`,
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    this.emit(failed!, 'error');
    return safeManagedDatabaseView(failed!);
  }

  private async completeDelete(row: ManagedDatabaseRow, userId: string | null) {
    await this.db.delete(managedDatabaseInstances).where(eq(managedDatabaseInstances.id, row.id));
    if (row.databaseConnectionId) {
      await this.db.delete(databaseConnections).where(eq(databaseConnections.id, row.databaseConnectionId));
    }
    await this.auditService.log({
      userId,
      action: 'database.managed.delete',
      resourceType: 'managed_database',
      resourceId: row.id,
      details: { name: row.name, type: row.type },
    });
    this.emit({ ...row, status: 'deleting' }, 'deleted');
  }

  private async getRow(id: string): Promise<ManagedDatabaseRow> {
    const [row] = await this.db
      .select()
      .from(managedDatabaseInstances)
      .where(eq(managedDatabaseInstances.id, id))
      .limit(1);
    if (!row) throw new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found');
    return row;
  }

  private async assertDatabaseNode(nodeId: string) {
    const [node] = await this.db
      .select({
        id: nodes.id,
        type: nodes.type,
        status: nodes.status,
        serviceAddress: nodes.serviceAddress,
        lastHealthReport: nodes.lastHealthReport,
      })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);
    if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Database node not found');
    if (node.type !== 'databases')
      throw new AppError(400, 'INVALID_DATABASE_NODE', 'Managed databases require a database node');
    if (node.status !== 'online') throw new AppError(409, 'NODE_OFFLINE', 'Database node is offline');
    return node;
  }

  private async ensureManagedDatabaseCertificate(
    row: ManagedDatabaseRow,
    node: { serviceAddress: string | null; lastHealthReport: unknown }
  ): Promise<ManagedDatabaseRow> {
    if (row.certificateId || !this.databaseCA) return row;
    const serviceAddresses = managedDatabaseServiceAddresses(node);
    if (serviceAddresses.length === 0) {
      throw new AppError(
        409,
        'MANAGED_DATABASE_TLS_IDENTITY_UNAVAILABLE',
        'Database node has no service IP addresses available for the managed TLS certificate'
      );
    }
    const issued = await this.databaseCA.issueManagedDatabaseCertificate(row.id, serviceAddresses);
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({ certificateId: issued.certificate.id, updatedAt: new Date() })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    return updated!;
  }

  private async createCanonicalConnection(
    name: string,
    type: ManagedDatabaseRow['type'],
    credentials: OwnerCredentials,
    storageSizeBytes: number,
    userId: string
  ) {
    const config = managedConnectionConfig(type, credentials);
    const encryptedConfig = JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config)));
    return writeWithAllocatedSlug({
      source: name,
      fallback: 'database',
      constraint: 'database_connections_slug_unique',
      write: async (slug) => {
        const [connection] = await this.db
          .insert(databaseConnections)
          .values({
            name,
            slug,
            type,
            tags: [],
            host: config.host,
            port: config.port,
            databaseName: config.type === 'redis' ? `db${config.db}` : config.database,
            username: config.username ?? null,
            tlsEnabled: config.type === 'postgres' ? config.sslEnabled : config.tlsEnabled,
            manualSizeLimitMb: type === 'postgres' ? Math.round(storageSizeBytes / MEBIBYTE) : null,
            encryptedConfig,
            healthStatus: 'unknown',
            createdById: userId,
            updatedById: userId,
          })
          .returning();
        return connection!;
      },
    });
  }

  private ownerCredentials(row: ManagedDatabaseRow): OwnerCredentials {
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedOwnerCredentials))
    ) as OwnerCredentials;
  }

  private directAccessCredentials(row: ManagedDatabaseRow): OwnerCredentials | null {
    if (!row.encryptedDirectCredentials) return null;
    return JSON.parse(
      this.cryptoService.decryptString(parseEncryptedCredentials(row.encryptedDirectCredentials))
    ) as OwnerCredentials;
  }

  private async ensureDirectAccessCredentials(
    row: ManagedDatabaseRow,
    userId: string | null,
    provision = true
  ): Promise<{ row: ManagedDatabaseRow; credentials: OwnerCredentials }> {
    const owner = this.ownerCredentials(row);
    const existing = this.directAccessCredentials(row);
    if (existing) {
      if (provision) await this.provisionDirectAccessPrincipal(row, owner, existing);
      return { row, credentials: existing };
    }
    const credentials = newDirectAccessCredentials(row.type, owner.databaseName);
    if (provision) await this.provisionDirectAccessPrincipal(row, owner, credentials);
    const [updated] = await this.db
      .update(managedDatabaseInstances)
      .set({
        encryptedDirectCredentials: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(credentials))),
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(managedDatabaseInstances.id, row.id))
      .returning();
    await this.syncCanonicalConnectionCredentials(updated!, credentials, userId);
    return { row: updated!, credentials };
  }

  private async provisionDirectAccessPrincipal(
    row: ManagedDatabaseRow,
    owner: OwnerCredentials,
    credentials: OwnerCredentials
  ) {
    const result = await this.nodeDispatch.sendDockerDatabaseCommand(
      row.nodeId,
      'binding_create',
      row.id,
      JSON.stringify({
        bindingId: row.id,
        username: credentials.username,
        password: credentials.password,
        databaseName: credentials.databaseName ?? 'redis',
        ownerUsername: owner.username,
        ownerPassword: owner.password,
      })
    );
    if (!result.success) {
      throw new AppError(
        503,
        'MANAGED_DATABASE_DIRECT_ACCESS_UNAVAILABLE',
        'Direct-access credentials could not be configured'
      );
    }
  }

  /**
   * Docker returns the selected ephemeral port in the normal lifecycle detail.
   * Treat that as an optimisation only: a reconnecting daemon can acknowledge
   * the operation with an empty detail, while the container itself is already
   * running. In that case inspect its durable record before exposing ready
   * state, otherwise the controller would mistakenly persist TCP as disabled.
   */
  private async resolvePublishedPort(
    row: ManagedDatabaseRow,
    publishTcp: boolean,
    result: { detail?: string }
  ): Promise<number | null> {
    const returned = allocatedPublishedPort(result);
    if (returned !== null) return returned;
    if (!publishTcp) return null;
    if (row.publishedPort !== null) return row.publishedPort;

    const inspected = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
    const inspectedPort = inspected.success ? allocatedPublishedPort(inspected) : null;
    if (inspectedPort !== null) return inspectedPort;
    throw new AppError(
      503,
      'MANAGED_DATABASE_PUBLICATION_UNCONFIRMED',
      'Managed database started, but its published TCP port could not be confirmed'
    );
  }

  private async resolvePublishedNativePort(
    row: ManagedDatabaseRow,
    publishNativeTcp: boolean,
    result: { detail?: string }
  ): Promise<number | null> {
    if (row.type !== 'clickhouse' || !publishNativeTcp) return null;
    const returned = allocatedPublishedNativePort(result);
    if (returned !== null) return returned;
    if (row.publishedNativePort !== null) return row.publishedNativePort;
    const inspected = await this.nodeDispatch.sendDockerDatabaseCommand(row.nodeId, 'inspect', row.id, '', 10_000);
    const inspectedPort = inspected.success ? allocatedPublishedNativePort(inspected) : null;
    if (inspectedPort !== null) return inspectedPort;
    throw new AppError(
      503,
      'MANAGED_DATABASE_NATIVE_PUBLICATION_UNCONFIRMED',
      'Managed ClickHouse started, but its published native TCP port could not be confirmed'
    );
  }

  private async syncCanonicalConnectionCredentials(
    row: ManagedDatabaseRow,
    credentials: OwnerCredentials,
    userId: string | null
  ) {
    if (!row.databaseConnectionId) return;
    const config = managedConnectionConfig(row.type, credentials);
    await this.db
      .update(databaseConnections)
      .set({
        host: config.host,
        port: config.port,
        databaseName: config.type === 'redis' ? `db${config.db}` : config.database,
        username: config.username ?? null,
        tlsEnabled: config.type === 'postgres' ? config.sslEnabled : config.tlsEnabled,
        encryptedConfig: JSON.stringify(this.cryptoService.encryptString(JSON.stringify(config))),
        ...(userId ? { updatedById: userId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }

  private async syncCanonicalConnectionName(row: ManagedDatabaseRow, previousName: string): Promise<void> {
    if (!row.databaseConnectionId || row.name === previousName) return;
    const [connection] = await this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.id, row.databaseConnectionId))
      .limit(1);
    if (!connection) return;
    const update = async (slug?: string) => {
      const [updated] = await this.db
        .update(databaseConnections)
        .set({ name: row.name, updatedById: row.updatedById, updatedAt: new Date(), ...(slug ? { slug } : {}) })
        .where(eq(databaseConnections.id, connection.id))
        .returning();
      return updated!;
    };
    const updated = await writeWithAllocatedSlug({
      source: row.name,
      fallback: 'database',
      constraint: 'database_connections_slug_unique',
      write: update,
    });
    this.eventBus?.publish('database.changed', {
      id: updated.id,
      action: 'updated',
      name: updated.name,
      type: updated.type,
      ...(updated.slug === connection.slug ? {} : { oldSlug: connection.slug, slug: updated.slug }),
    });
  }

  private async syncCanonicalConnectionStorageLimit(row: ManagedDatabaseRow): Promise<void> {
    if (!row.databaseConnectionId || row.type !== 'postgres') return;
    await this.db
      .update(databaseConnections)
      .set({
        manualSizeLimitMb: Math.round(Number(row.storageSizeBytes) / MEBIBYTE),
        updatedById: row.updatedById,
        updatedAt: new Date(),
      })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }

  private async syncCanonicalConnectionTags(row: ManagedDatabaseRow, tags: string[] | undefined): Promise<void> {
    if (!row.databaseConnectionId || tags === undefined) return;
    await this.db
      .update(databaseConnections)
      .set({ tags, updatedById: row.updatedById, updatedAt: new Date() })
      .where(eq(databaseConnections.id, row.databaseConnectionId));
  }

  private emit(
    row: Pick<ManagedDatabaseRow, 'id' | 'databaseConnectionId' | 'name' | 'type' | 'status'>,
    action: string
  ) {
    this.eventBus?.publish('database.changed', {
      id: row.databaseConnectionId ?? row.id,
      managedDatabaseId: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      action,
    });
  }
}
