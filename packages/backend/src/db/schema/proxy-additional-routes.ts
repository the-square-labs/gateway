import { boolean, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { dockerComposeProjects } from './docker-compose.js';
import { dockerDeployments } from './docker-deployments.js';
import { nodes } from './nodes.js';
import { pageDeployments, pageProjects, pageTags } from './pages.js';
import { proxyAdditionalSecureLinks } from './proxy-additional-secure-links.js';
import { forwardSchemeEnum, proxyHosts } from './proxy-hosts.js';
import { users } from './users.js';

export const proxyAdditionalRouteTargetKindEnum = pgEnum('proxy_additional_route_target_kind', [
  'manual',
  'docker_container',
  'docker_deployment',
  'pages',
]);

export const proxyAdditionalRouteStatusEnum = pgEnum('proxy_additional_route_status', [
  'staging',
  'provisioning',
  'ready',
  'disabled',
  'failed',
  'cleanup_pending',
]);

/**
 * Persisted managed path-prefix route.  The target columns intentionally
 * mirror the existing proxy-host union so the route can reuse the Docker
 * resolver and Pages Tag publication/runtime contracts without accepting an
 * arbitrary Nginx snippet.
 */
export const proxyAdditionalRoutes = pgTable(
  'proxy_additional_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proxyHostId: uuid('proxy_host_id')
      .notNull()
      .references(() => proxyHosts.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 1024 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    targetKind: proxyAdditionalRouteTargetKindEnum('target_kind').notNull(),

    // Manual target.
    forwardHost: varchar('forward_host', { length: 255 }),
    forwardPort: integer('forward_port'),
    forwardScheme: forwardSchemeEnum('forward_scheme').notNull().default('http'),

    // Docker target.  The Secure Link row is created only after the route row
    // exists, so the route can be retried without losing its target intent.
    dockerNodeId: uuid('docker_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    dockerContainerName: varchar('docker_container_name', { length: 255 }),
    dockerComposeProjectId: uuid('docker_compose_project_id').references(() => dockerComposeProjects.id, {
      onDelete: 'restrict',
    }),
    dockerComposeServiceName: varchar('docker_compose_service_name', { length: 255 }),
    dockerDeploymentId: uuid('docker_deployment_id').references(() => dockerDeployments.id, { onDelete: 'restrict' }),
    dockerContainerPort: integer('docker_container_port'),
    dockerHostPort: integer('docker_host_port'),
    dockerProtocol: varchar('docker_protocol', { length: 8 }),
    secureLinkId: uuid('secure_link_id').references(() => proxyAdditionalSecureLinks.id, { onDelete: 'set null' }),

    // Durable ingress-node migration claim.  During a move the staged target
    // binding/include is published while the source remains active; the
    // previous resource reference is retained until the new host config has
    // been applied and the claim is committed.
    migrationSourceNodeId: uuid('migration_source_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    migrationTargetNodeId: uuid('migration_target_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    migrationPreviousSecureLinkId: uuid('migration_previous_secure_link_id').references(
      () => proxyAdditionalSecureLinks.id,
      { onDelete: 'set null' }
    ),
    migrationPreviousIncludePath: text('migration_previous_include_path'),
    migrationPreviousRuntimeConfigGeneration: integer('migration_previous_runtime_config_generation'),

    // Pages Tag target.  Restrictive references keep a selected Tag and its
    // active Deployment from being deleted while this route is attached.
    pageProjectId: uuid('page_project_id').references(() => pageProjects.id, { onDelete: 'restrict' }),
    pageTagId: uuid('page_tag_id').references(() => pageTags.id, { onDelete: 'restrict' }),
    activeDeploymentId: uuid('active_deployment_id').references(() => pageDeployments.id, { onDelete: 'restrict' }),
    includePath: text('include_path'),
    runtimeConfigPath: text('runtime_config_path'),
    runtimeConfigGeneration: integer('runtime_config_generation').notNull().default(0),
    advancedConfig: text('advanced_config'),

    // Bounded location controls.
    stripPrefix: boolean('strip_prefix').notNull().default(false),
    websocketSupport: boolean('websocket_support').notNull().default(false),
    requestBuffering: boolean('request_buffering').notNull().default(true),
    responseBuffering: boolean('response_buffering').notNull().default(true),
    connectTimeoutSeconds: integer('connect_timeout_seconds').notNull().default(60),
    readTimeoutSeconds: integer('read_timeout_seconds').notNull().default(60),
    sendTimeoutSeconds: integer('send_timeout_seconds').notNull().default(60),

    generation: integer('generation').notNull().default(0),
    status: proxyAdditionalRouteStatusEnum('status').notNull().default('staging'),
    lastError: text('last_error'),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    hostPathUnique: unique('proxy_additional_routes_host_path_unique').on(table.proxyHostId, table.path),
    hostIdx: index('proxy_additional_routes_host_idx').on(table.proxyHostId),
    targetIdx: index('proxy_additional_routes_target_idx').on(table.targetKind),
    dockerNodeIdx: index('proxy_additional_routes_docker_node_idx').on(table.dockerNodeId),
    dockerComposeProjectIdx: index('proxy_additional_routes_docker_compose_project_idx').on(
      table.dockerComposeProjectId
    ),
    dockerDeploymentIdx: index('proxy_additional_routes_docker_deployment_idx').on(table.dockerDeploymentId),
    pagesTagIdx: index('proxy_additional_routes_pages_tag_idx').on(table.pageTagId),
    pagesDeploymentIdx: index('proxy_additional_routes_pages_deployment_idx').on(table.activeDeploymentId),
    secureLinkIdx: index('proxy_additional_routes_secure_link_idx').on(table.secureLinkId),
    migrationTargetIdx: index('proxy_additional_routes_migration_target_idx').on(table.migrationTargetNodeId),
    statusIdx: index('proxy_additional_routes_status_idx').on(table.status),
  })
);

export type ProxyAdditionalRouteRow = typeof proxyAdditionalRoutes.$inferSelect;
