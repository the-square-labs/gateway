import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';
import { users } from './users.js';

export type DockerManagedVolumeOrigin = 'created' | 'adopted';

export const dockerManagedVolumes = pgTable(
  'docker_managed_volumes',
  {
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    volumeName: text('volume_name').notNull(),
    origin: text('origin').$type<DockerManagedVolumeOrigin>().notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.nodeId, table.volumeName], name: 'docker_managed_volumes_pkey' }),
    index('docker_managed_volumes_created_by_idx').on(table.createdById),
  ]
);

export type DockerManagedVolume = typeof dockerManagedVolumes.$inferSelect;
