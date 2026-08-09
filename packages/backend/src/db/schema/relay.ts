import { bigint, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';

export const relaySigningKeyStatusEnum = pgEnum('relay_signing_key_status', [
  'pending',
  'active',
  'verification_only',
  'retired',
]);

export const relayGrantSigningKeys = pgTable(
  'relay_grant_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: relaySigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    privateKeyDestroyedAt: timestamp('private_key_destroyed_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => ({
    keyIdUnique: unique('relay_grant_signing_keys_key_id_unique').on(table.keyId),
    statusIdx: index('relay_grant_signing_keys_status_idx').on(table.status),
  })
);

export const relayPolicyState = pgTable('relay_policy_state', {
  id: varchar('id', { length: 32 }).primaryKey(),
  gatewayInstanceId: uuid('gateway_instance_id').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relayEndpoints = pgTable(
  'relay_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    subjectKind: varchar('subject_kind', { length: 32 }).notNull(),
    subjectId: uuid('subject_id').notNull(),
    certificateSha256: varchar('certificate_sha256', { length: 71 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(256),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUnique: unique('relay_endpoints_owner_unique').on(table.ownerKind, table.ownerId),
    subjectIdx: index('relay_endpoints_subject_idx').on(table.subjectKind, table.subjectId),
  })
);

export const relayRoutes = pgTable(
  'relay_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceCertificateSha256: varchar('source_certificate_sha256', { length: 71 }).notNull(),
    targetEndpointId: uuid('target_endpoint_id')
      .notNull()
      .references(() => relayEndpoints.id, { onDelete: 'cascade' }),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(16),
    maxFrameBytes: integer('max_frame_bytes')
      .notNull()
      .default(1024 * 1024),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUnique: unique('relay_routes_owner_unique').on(table.ownerKind, table.ownerId),
    sourceIdx: index('relay_routes_source_idx').on(table.sourceKind, table.sourceId),
    targetIdx: index('relay_routes_target_idx').on(table.targetEndpointId),
  })
);
