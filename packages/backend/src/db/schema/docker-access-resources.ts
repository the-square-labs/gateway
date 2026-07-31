import { index, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

export const dockerAccessResources = pgTable(
  'docker_access_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    resourceType: varchar('resource_type', { length: 32 }).$type<'container'>().notNull().default('container'),
    resourceKey: varchar('resource_key', { length: 255 }).notNull(),
    runtimeId: text('runtime_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('docker_access_resources_node_type_key_unique').on(table.nodeId, table.resourceType, table.resourceKey),
    index('docker_access_resources_node_runtime_idx').on(table.nodeId, table.runtimeId),
  ]
);

export type DockerAccessResource = typeof dockerAccessResources.$inferSelect;
