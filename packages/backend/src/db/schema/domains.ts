import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { domainFolders } from './domain-folders.js';
import { integrationConnectors } from './integration-connectors.js';
import { nodes } from './nodes.js';
import { users } from './users.js';

export const dnsStatusEnum = pgEnum('dns_status', ['valid', 'invalid', 'pending', 'unknown']);
export const domainDnsProviderEnum = pgEnum('domain_dns_provider', ['legacy', 'cloudflare']);
export const domainDnsOwnershipEnum = pgEnum('domain_dns_ownership', [
  'legacy',
  'created',
  'matched_existing',
  'overwritten',
]);

export interface DnsRecords {
  a: string[];
  aaaa: string[];
  cname: string[];
  caa: Array<{ critical: number; issue?: string; issuewild?: string }>;
  mx: Array<{ exchange: string; priority: number }>;
  txt: string[][];
}

export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domain: varchar('domain', { length: 253 }).notNull().unique(),
    description: text('description'),
    dnsStatus: dnsStatusEnum('dns_status').notNull().default('pending'),
    lastDnsCheckAt: timestamp('last_dns_check_at', { withTimezone: true }),
    dnsRecords: jsonb('dns_records').$type<DnsRecords>(),
    dnsProvider: domainDnsProviderEnum('dns_provider').notNull().default('legacy'),
    dnsOwnership: domainDnsOwnershipEnum('dns_ownership').notNull().default('legacy'),
    integrationConnectorId: uuid('integration_connector_id').references(() => integrationConnectors.id, {
      onDelete: 'set null',
    }),
    providerZoneId: varchar('provider_zone_id', { length: 128 }),
    providerZoneName: text('provider_zone_name'),
    providerRecordIds: jsonb('provider_record_ids').$type<string[]>().notNull().default([]),
    dnsRecordType: varchar('dns_record_type', { length: 16 }),
    dnsTargetIps: jsonb('dns_target_ips').$type<string[]>().notNull().default([]),
    dnsTtl: integer('dns_ttl'),
    dnsProxied: boolean('dns_proxied'),
    nginxNodeId: uuid('nginx_node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    pendingDnsTargetIp: varchar('pending_dns_target_ip', { length: 45 }),
    // System flag — locked domains cannot be deleted (e.g. management domain)
    isSystem: boolean('is_system').notNull().default(false),
    folderId: uuid('folder_id').references((): AnyPgColumn => domainFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('domain_domain_idx').on(table.domain),
    index('domain_dns_status_idx').on(table.dnsStatus),
    index('domain_dns_provider_idx').on(table.dnsProvider),
    index('domain_integration_connector_idx').on(table.integrationConnectorId),
    index('domain_nginx_node_idx').on(table.nginxNodeId),
    index('domain_created_by_idx').on(table.createdById),
    index('domain_folder_idx').on(table.folderId),
  ]
);
