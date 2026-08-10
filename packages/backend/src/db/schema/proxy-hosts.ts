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
import { accessLists } from './access-lists.js';
import { certificates } from './certificates.js';
import { dockerDeployments } from './docker-deployments.js';
import { nginxTemplates } from './nginx-templates.js';
import { nodes } from './nodes.js';
import { proxyHostFolders } from './proxy-host-folders.js';
import { sslCertificates } from './ssl-certificates.js';
import { users } from './users.js';

export const proxyHostTypeEnum = pgEnum('proxy_host_type', ['proxy', 'redirect', '404', 'raw']);
export const forwardSchemeEnum = pgEnum('forward_scheme', ['http', 'https']);
export const proxyUpstreamKindEnum = pgEnum('proxy_upstream_kind', ['manual', 'docker_container', 'docker_deployment']);
export const healthStatusEnum = pgEnum('health_status', ['online', 'offline', 'degraded', 'unknown', 'disabled']);
export const healthCheckBodyMatchModeEnum = pgEnum('health_check_body_match_mode', [
  'includes',
  'exact',
  'starts_with',
  'ends_with',
]);

export interface CustomHeader {
  name: string;
  value: string;
}

export interface CacheOptions {
  maxAge?: number;
  staleWhileRevalidate?: number;
}

export interface RateLimitOptions {
  requestsPerSecond: number;
  burst?: number;
}

export interface RewriteRule {
  source: string;
  destination: string;
  type: 'permanent' | 'temporary';
}

export const proxyHosts = pgTable(
  'proxy_hosts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: proxyHostTypeEnum('type').notNull().default('proxy'),
    domainNames: jsonb('domain_names').$type<string[]>().notNull().default([]),
    slug: varchar('slug', { length: 60 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    maintenanceEnabled: boolean('maintenance_enabled').notNull().default(false),
    maintenanceStartedAt: timestamp('maintenance_started_at', { withTimezone: true }),

    // Upstream — for proxy type
    upstreamKind: proxyUpstreamKindEnum('upstream_kind').notNull().default('manual'),
    forwardHost: varchar('forward_host', { length: 255 }),
    forwardPort: integer('forward_port'),
    forwardScheme: forwardSchemeEnum('forward_scheme').default('http'),
    dockerNodeId: uuid('docker_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    dockerContainerName: varchar('docker_container_name', { length: 255 }),
    dockerDeploymentId: uuid('docker_deployment_id').references(() => dockerDeployments.id, {
      onDelete: 'restrict',
    }),
    dockerContainerPort: integer('docker_container_port'),
    dockerHostPort: integer('docker_host_port'),
    dockerProtocol: varchar('docker_protocol', { length: 8 }),

    // Internal Proxy Host -> Docker Secure Link runtime state. These fields
    // are control-plane metadata and are not exposed as a selectable upstream.
    secureLinkGeneration: integer('secure_link_generation').notNull().default(0),
    secureLinkStatus: varchar('secure_link_status', { length: 32 }).notNull().default('legacy'),
    secureLinkLastError: text('secure_link_last_error'),
    secureLinkTargetNetwork: varchar('secure_link_target_network', { length: 255 }),
    secureLinkTargetContainer: varchar('secure_link_target_container', { length: 255 }),
    secureLinkTargetHost: varchar('secure_link_target_host', { length: 255 }),
    secureLinkListenerPort: integer('secure_link_listener_port'),
    secureLinkConnectorPort: integer('secure_link_connector_port'),
    secureLinkMigratedAt: timestamp('secure_link_migrated_at', { withTimezone: true }),

    // SSL
    sslEnabled: boolean('ssl_enabled').notNull().default(false),
    sslForced: boolean('ssl_forced').notNull().default(false), // HTTP → HTTPS redirect
    http2Support: boolean('http2_support').notNull().default(true),
    sslCertificateId: uuid('ssl_certificate_id').references(() => sslCertificates.id, { onDelete: 'set null' }),
    internalCertificateId: uuid('internal_certificate_id').references(() => certificates.id, { onDelete: 'set null' }),

    // Proxy options
    websocketSupport: boolean('websocket_support').notNull().default(false),

    // Redirect type options
    redirectUrl: text('redirect_url'),
    redirectStatusCode: integer('redirect_status_code').default(301),

    // Custom config — structured
    customHeaders: jsonb('custom_headers').$type<CustomHeader[]>().default([]),
    cacheEnabled: boolean('cache_enabled').notNull().default(false),
    cacheOptions: jsonb('cache_options').$type<CacheOptions>(),
    rateLimitEnabled: boolean('rate_limit_enabled').notNull().default(false),
    rateLimitOptions: jsonb('rate_limit_options').$type<RateLimitOptions>(),
    customRewrites: jsonb('custom_rewrites').$type<RewriteRule[]>().default([]),

    // Custom config — raw nginx
    advancedConfig: text('advanced_config'),

    // Raw config override — bypasses template rendering entirely
    rawConfig: text('raw_config'),
    rawConfigEnabled: boolean('raw_config_enabled').notNull().default(false),

    // Folder / organization
    folderId: uuid('folder_id').references(() => proxyHostFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    // Nginx config template
    nginxTemplateId: uuid('nginx_template_id').references(() => nginxTemplates.id, { onDelete: 'set null' }),
    templateVariables: jsonb('template_variables').$type<Record<string, string | number | boolean>>().default({}),

    // Access list
    accessListId: uuid('access_list_id').references(() => accessLists.id, { onDelete: 'set null' }),

    // Node assignment
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'set null' }),

    // Health check
    healthCheckEnabled: boolean('health_check_enabled').notNull().default(false),
    healthCheckUrl: varchar('health_check_url', { length: 500 }).default('/'),
    healthCheckInterval: integer('health_check_interval').default(30), // seconds
    healthCheckExpectedStatus: integer('health_check_expected_status'), // null = accept 2xx
    healthCheckExpectedBody: varchar('health_check_expected_body', { length: 500 }), // null = don't check body
    healthCheckBodyMatchMode: healthCheckBodyMatchModeEnum('health_check_body_match_mode')
      .notNull()
      .default('includes'),
    healthCheckSlowThreshold: integer('health_check_slow_threshold').default(3), // Nx multiplier for response time degradation
    healthStatus: healthStatusEnum('health_status').default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    healthHistory: jsonb('health_history')
      .$type<Array<{ ts: string; status: string; responseMs?: number; slow?: boolean }>>()
      .default([]),

    // System flag — locked hosts cannot be deleted (e.g. management proxy)
    isSystem: boolean('is_system').notNull().default(false),
    systemKind: varchar('system_kind', { length: 50 }),

    // Metadata
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    enabledIdx: index('proxy_host_enabled_idx').on(table.enabled),
    typeIdx: index('proxy_host_type_idx').on(table.type),
    folderIdx: index('proxy_host_folder_idx').on(table.folderId),
    createdByIdx: index('proxy_host_created_by_idx').on(table.createdById),
    nodeIdx: index('proxy_host_node_idx').on(table.nodeId),
    dockerNodeIdx: index('proxy_host_docker_node_idx').on(table.dockerNodeId),
    dockerDeploymentIdx: index('proxy_host_docker_deployment_idx').on(table.dockerDeploymentId),
    systemKindIdx: index('proxy_host_system_kind_idx').on(table.systemKind),
    slugUnique: unique('proxy_hosts_slug_unique').on(table.slug),
  })
);
