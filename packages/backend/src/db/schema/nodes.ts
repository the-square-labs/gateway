import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodeFolders } from './node-folders.js';

export const nodeTypeEnum = pgEnum('node_type', ['nginx', 'bastion', 'monitoring', 'docker', 'databases', 'relay']);
export const nodeStatusEnum = pgEnum('node_status', ['pending', 'online', 'offline', 'error']);

export interface NodeCapabilities {
  nginxVersion?: string;
  dockerVersion?: string;
  configDir?: string;
  daemonType?: string;
  dockerRuntimeStatus?: {
    state: 'healthy' | 'installable' | 'unsupported' | 'unknown' | 'installing' | 'failed';
    installedVersion?: string;
    targetVersion?: string;
    reasonCode?: string;
    message?: string;
    checkedAt: string;
    remoteInstallable: boolean;
    localInstallCommand?: string;
    step?:
      | 'preparing'
      | 'downloading'
      | 'verifying_download'
      | 'installing_binaries'
      | 'configuring_docker'
      | 'restarting_docker'
      | 'verifying_runtime';
    progressPercent?: number;
  };
  [key: string]: unknown;
}

export interface NodeGpuDevice {
  id: string;
  vendor: string;
  model: string;
  pciAddress: string;
  renderNode: string;
  deviceIndex: number;
  attachable: boolean;
  unavailableReason: string;
  partitioned: boolean;
  availableMetrics: string[];
  utilizationPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  temperatureCelsius?: number;
  powerWatts?: number;
  powerLimitWatts?: number;
  throttled?: boolean;
  eccCorrectedErrors?: number;
  eccUncorrectedErrors?: number;
  health?: string;
}

export interface NodeHealthReport {
  nginxRunning: boolean;
  configValid: boolean;
  nginxUptimeSeconds: number;
  workerCount: number;
  nginxVersion: string;
  cpuPercent: number;
  memoryBytes: number;
  diskFreeBytes: number;
  timestamp: number;
  // System
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  systemMemoryTotalBytes: number;
  systemMemoryUsedBytes: number;
  systemMemoryAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  systemUptimeSeconds: number;
  openFileDescriptors: number;
  maxFileDescriptors: number;
  // Disk
  diskMounts: Array<{
    mountPoint: string;
    filesystem: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number;
  }>;
  diskReadBytes: number;
  diskWriteBytes: number;
  // Network
  networkInterfaces: Array<{
    name: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
    rxErrors: number;
    txErrors: number;
    ipAddresses?: string[];
  }>;
  localIpAddresses: string[];
  publicIpAddresses?: string[];
  // Nginx
  nginxRssBytes: number;
  errorRate4xx: number;
  errorRate5xx: number;
  // Physical GPU inventory. Optional telemetry fields are only present when
  // the daemon explicitly reports the corresponding available metric.
  gpuDevices?: NodeGpuDevice[];
}

export interface NodeStatsReport {
  activeConnections: number;
  accepts: number;
  handled: number;
  requests: number;
  reading: number;
  writing: number;
  waiting: number;
  timestamp: number;
}

export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: nodeTypeEnum('type').notNull().default('nginx'),
    hostname: varchar('hostname', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    slug: varchar('slug', { length: 60 }).notNull(),
    appearanceColor: varchar('appearance_color', { length: 32 }),
    serviceAddresses: text('service_addresses').array().notNull().default([]),
    serviceAddress: varchar('service_address', { length: 255 }),
    secondaryServiceAddress: varchar('secondary_service_address', { length: 255 }),
    status: nodeStatusEnum('status').notNull().default('pending'),
    serviceCreationLocked: boolean('service_creation_locked').notNull().default(false),

    // Enrollment
    enrollmentTokenSelector: varchar('enrollment_token_selector', { length: 32 }),
    enrollmentTokenHash: varchar('enrollment_token_hash', { length: 255 }),
    certificateSerial: varchar('certificate_serial', { length: 255 }),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }),
    certificateExpiresAt: timestamp('certificate_expires_at', { withTimezone: true }),

    // Stable opaque identity of the physical host. Colocated daemon roles have
    // distinct node identities but share this value for fault-domain accounting.
    hostIdentityId: uuid('host_identity_id'),

    // Daemon info
    daemonVersion: varchar('daemon_version', { length: 50 }),
    osInfo: varchar('os_info', { length: 255 }),
    configVersionHash: varchar('config_version_hash', { length: 64 }),

    // Type-specific capabilities (e.g. { nginxVersion, configDir })
    capabilities: jsonb('capabilities').$type<NodeCapabilities>().default({}),

    // Latest reports
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastHealthReport: jsonb('last_health_report').$type<NodeHealthReport>(),
    lastStatsReport: jsonb('last_stats_report').$type<NodeStatsReport>(),

    // Health history: timestamped status entries (same format as proxy hosts)
    healthHistory: jsonb('health_history').$type<Array<{ ts: string; status: string }>>().default([]),

    // Extensible metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    // Folder / organization
    folderId: uuid('folder_id').references(() => nodeFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('node_type_idx').on(table.type),
    statusIdx: index('node_status_idx').on(table.status),
    hostnameIdx: index('node_hostname_idx').on(table.hostname),
    enrollmentTokenSelectorIdx: index('node_enrollment_token_selector_idx').on(table.enrollmentTokenSelector),
    hostIdentityIdx: index('node_host_identity_idx').on(table.hostIdentityId),
    folderIdx: index('node_folder_idx').on(table.folderId),
    slugUnique: unique('nodes_slug_unique').on(table.slug),
  })
);
