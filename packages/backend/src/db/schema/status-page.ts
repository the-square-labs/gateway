import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const statusPageSourceTypeEnum = pgEnum('status_page_source_type', [
  'node',
  'proxy_host',
  'database',
  'docker_container',
  'docker_deployment',
  'docker_compose_project',
  'pages_project',
]);
export const statusPageIncidentSeverityEnum = pgEnum('status_page_incident_severity', ['info', 'warning', 'critical']);
export const statusPageIncidentStatusEnum = pgEnum('status_page_incident_status', ['active', 'resolved']);
export const statusPageIncidentTypeEnum = pgEnum('status_page_incident_type', ['automatic', 'manual']);
export const statusPageIncidentUpdateStatusEnum = pgEnum('status_page_incident_update_status', [
  'update',
  'investigating',
  'identified',
  'monitoring',
  'resolved',
]);

export const statusPageServices = pgTable(
  'status_page_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceType: statusPageSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    publicName: varchar('public_name', { length: 255 }).notNull(),
    publicDescription: text('public_description'),
    publicGroup: varchar('public_group', { length: 255 }),
    sortOrder: integer('sort_order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    createThresholdSeconds: integer('create_threshold_seconds').notNull().default(600),
    resolveThresholdSeconds: integer('resolve_threshold_seconds').notNull().default(60),
    lastEvaluatedStatus: varchar('last_evaluated_status', { length: 32 }).notNull().default('unknown'),
    unhealthySince: timestamp('unhealthy_since', { withTimezone: true }),
    healthySince: timestamp('healthy_since', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceIdx: index('status_page_services_source_idx').on(table.sourceType, table.sourceId),
    enabledIdx: index('status_page_services_enabled_idx').on(table.enabled),
    sortIdx: index('status_page_services_sort_idx').on(table.sortOrder),
  })
);

export const statusPageIncidents = pgTable(
  'status_page_incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    severity: statusPageIncidentSeverityEnum('severity').notNull().default('warning'),
    status: statusPageIncidentStatusEnum('status').notNull().default('active'),
    type: statusPageIncidentTypeEnum('type').notNull().default('manual'),
    autoManaged: boolean('auto_managed').notNull().default(false),
    affectedServiceIds: jsonb('affected_service_ids').$type<string[]>().notNull().default([]),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('status_page_incidents_status_idx').on(table.status),
    typeIdx: index('status_page_incidents_type_idx').on(table.type),
    startedIdx: index('status_page_incidents_started_idx').on(table.startedAt),
  })
);

export const statusPageIncidentUpdates = pgTable(
  'status_page_incident_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => statusPageIncidents.id, { onDelete: 'cascade' }),
    status: statusPageIncidentUpdateStatusEnum('status').notNull().default('update'),
    message: text('message').notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    incidentIdx: index('status_page_incident_updates_incident_idx').on(table.incidentId),
    createdIdx: index('status_page_incident_updates_created_idx').on(table.createdAt),
  })
);
