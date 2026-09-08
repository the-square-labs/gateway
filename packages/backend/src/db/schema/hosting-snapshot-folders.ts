import { type AnyPgColumn, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hostingResources } from './hosting.js';
import { users } from './users.js';
export const hostingSnapshotFolders = pgTable(
  'hosting_snapshot_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => hostingResources.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => hostingSnapshotFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('hosting_snapshot_folder_resource_idx').on(t.resourceId)]
);
export const hostingSnapshotPlacements = pgTable(
  'hosting_snapshot_placements',
  {
    id: uuid('id').primaryKey(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => hostingResources.id, { onDelete: 'cascade' }),
    snapshotId: text('snapshot_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    folderId: uuid('folder_id').references(() => hostingSnapshotFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('hosting_snapshot_placement_resource_idx').on(t.resourceId)]
);
