import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { dockerDeployments } from './docker-deployments.js';
import { nodes } from './nodes.js';
import { forwardSchemeEnum, proxyHosts, proxyUpstreamKindEnum } from './proxy-hosts.js';

export const proxyAdditionalSecureLinks = pgTable(
  'proxy_additional_secure_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proxyHostId: uuid('proxy_host_id')
      .notNull()
      .references(() => proxyHosts.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    // User-created Advanced bindings and Additional Route bindings share the
    // same relay/listener projection.  The purpose/reference pair is an
    // internal ownership boundary: user-facing Advanced surfaces must only
    // read `user_managed` rows, while the Additional Route runtime reads
    // `additional_route` rows by reference id.
    purpose: varchar('purpose', { length: 32 })
      .$type<'user_managed' | 'additional_route'>()
      .notNull()
      .default('user_managed'),
    referenceId: uuid('reference_id'),
    upstreamKind: proxyUpstreamKindEnum('upstream_kind').notNull(),
    forwardScheme: forwardSchemeEnum('forward_scheme').notNull().default('http'),
    sourceNodeId: uuid('source_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    dockerNodeId: uuid('docker_node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'restrict' }),
    dockerContainerName: varchar('docker_container_name', { length: 255 }),
    dockerDeploymentId: uuid('docker_deployment_id').references(() => dockerDeployments.id, {
      onDelete: 'restrict',
    }),
    dockerContainerPort: integer('docker_container_port').notNull(),
    dockerHostPort: integer('docker_host_port').notNull(),
    targetNetwork: varchar('target_network', { length: 255 }).notNull().default(''),
    targetContainer: varchar('target_container', { length: 255 }).notNull(),
    generation: integer('generation').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('provisioning'),
    lastError: text('last_error'),
    listenerPort: integer('listener_port'),
    connectorPort: integer('connector_port'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    purposeCheck: check(
      'proxy_additional_secure_links_purpose_check',
      sql`${table.purpose} in ('user_managed', 'additional_route')`
    ),
    hostNameUnique: unique('proxy_additional_secure_links_host_name_unique').on(table.proxyHostId, table.name),
    hostIdx: index('proxy_additional_secure_links_host_idx').on(table.proxyHostId),
    purposeReferenceIdx: index('proxy_additional_secure_links_purpose_reference_idx').on(
      table.purpose,
      table.referenceId
    ),
    sourceNodeIdx: index('proxy_additional_secure_links_source_node_idx').on(table.sourceNodeId),
    targetNodeIdx: index('proxy_additional_secure_links_target_node_idx').on(table.dockerNodeId),
    statusIdx: index('proxy_additional_secure_links_status_idx').on(table.status),
  })
);
