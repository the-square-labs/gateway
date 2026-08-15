import { boolean, index, integer, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export type ExternalSshAuthMethod = 'password' | 'private_key';
export type ExternalSshTestStatus = 'never' | 'success' | 'error';

export const externalSshConnectors = pgTable(
  'external_ssh_connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull().default(22),
    username: varchar('username', { length: 255 }).notNull(),
    authMethod: varchar('auth_method', { length: 32 }).$type<ExternalSshAuthMethod>().notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    encryptedPassphrase: text('encrypted_passphrase'),
    hostFingerprint: varchar('host_fingerprint', { length: 255 }).notNull(),
    jumpConnectorId: uuid('jump_connector_id').references((): any => externalSshConnectors.id, {
      onDelete: 'restrict',
    }),
    enabled: boolean('enabled').notNull().default(true),
    testStatus: varchar('test_status', { length: 32 }).$type<ExternalSshTestStatus>().notNull().default('never'),
    testLastError: text('test_last_error'),
    testedAt: timestamp('tested_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('external_ssh_connector_name_unique').on(table.name),
    index('external_ssh_connector_host_idx').on(table.host),
    index('external_ssh_connector_jump_idx').on(table.jumpConnectorId),
    index('external_ssh_connector_health_idx').on(table.enabled, table.testedAt),
  ]
);
