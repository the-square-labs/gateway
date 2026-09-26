import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

export type NodeHostPortProtocol = 'tcp' | 'udp';
export type NodeHostPortOwnerKind = 'deployment' | 'managed_storage' | 'managed_database';

/**
 * One host port a Gateway-managed workload holds on its node. The partial
 * unique index is the guarantee that two workloads never reserve the same
 * port; the owner tables keep these rows in sync through triggers (migration
 * 0207), so an owner's write fails with a unique violation instead of the
 * daemon failing to bind later.
 *
 * `conflict` marks a reservation recorded although another owner already held
 * the port: collisions that existed before this table, and ports a daemon
 * picked or a migrated workload already binds. Those rows stay outside the
 * unique index, and a new reservation of the port is still refused.
 */
export const nodeHostPortReservations = pgTable(
  'node_host_port_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    protocol: varchar('protocol', { length: 8 }).$type<NodeHostPortProtocol>().notNull().default('tcp'),
    hostPort: integer('host_port').notNull(),
    ownerKind: varchar('owner_kind', { length: 32 }).$type<NodeHostPortOwnerKind>().notNull(),
    ownerId: uuid('owner_id').notNull(),
    conflict: boolean('conflict').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('node_host_port_reservations_port_unique')
      .on(table.nodeId, table.protocol, table.hostPort)
      .where(sql`${table.conflict} = false`),
    uniqueIndex('node_host_port_reservations_owner_port_unique').on(
      table.ownerKind,
      table.ownerId,
      table.protocol,
      table.hostPort
    ),
    check('node_host_port_reservations_protocol_valid', sql`${table.protocol} IN ('tcp', 'udp')`),
    check('node_host_port_reservations_port_valid', sql`${table.hostPort} BETWEEN 1 AND 65535`),
    check(
      'node_host_port_reservations_owner_kind_valid',
      sql`${table.ownerKind} IN ('deployment', 'managed_storage', 'managed_database')`
    ),
  ]
);

export type NodeHostPortReservationRow = typeof nodeHostPortReservations.$inferSelect;
