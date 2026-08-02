import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const caTypeEnum = pgEnum('ca_type', ['root', 'intermediate']);
export const caStatusEnum = pgEnum('ca_status', ['active', 'revoked', 'expired']);
export const keyAlgorithmEnum = pgEnum('key_algorithm', ['rsa-2048', 'rsa-4096', 'ecdsa-p256', 'ecdsa-p384']);
// System-managed CAs are purpose-scoped. Node mTLS and published database TLS
// must never share a trust anchor.
export const systemCAPurposeEnum = pgEnum('system_ca_purpose', ['node-mtls', 'database-tls']);

export const certificateAuthorities = pgTable(
  'certificate_authorities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id').references((): any => certificateAuthorities.id, { onDelete: 'restrict' }),
    type: caTypeEnum('type').notNull(),
    status: caStatusEnum('status').notNull().default('active'),
    commonName: varchar('common_name', { length: 255 }).notNull(),
    keyAlgorithm: keyAlgorithmEnum('key_algorithm').notNull(),
    serialNumber: varchar('serial_number', { length: 255 }).notNull(),

    // Key storage — envelope encryption
    encryptedPrivateKey: text('encrypted_private_key').notNull(),
    encryptedDek: text('encrypted_dek').notNull(),
    dekIv: text('dek_iv').notNull(),

    // Certificate data
    certificatePem: text('certificate_pem').notNull(),
    subjectDn: text('subject_dn').notNull(),
    issuerDn: text('issuer_dn'),

    // Constraints
    pathLengthConstraint: integer('path_length_constraint'),
    maxValidityDays: integer('max_validity_days').notNull().default(365),

    // Validity
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),

    // OCSP delegated responder
    ocspCertPem: text('ocsp_cert_pem'),
    encryptedOcspKey: text('encrypted_ocsp_key'),
    encryptedOcspDek: text('encrypted_ocsp_dek'),
    ocspDekIv: text('ocsp_dek_iv'),

    // Distribution endpoints (embedded into issued certs)
    crlDistributionUrl: varchar('crl_distribution_url', { length: 500 }),
    ocspResponderUrl: varchar('ocsp_responder_url', { length: 500 }),
    caIssuersUrl: varchar('ca_issuers_url', { length: 500 }),

    // CRL tracking
    crlNumber: integer('crl_number').notNull().default(0),
    lastCrlAt: timestamp('last_crl_at', { withTimezone: true }),

    // System flag — locked CAs cannot be deleted (e.g. node mTLS CA)
    isSystem: boolean('is_system').notNull().default(false),
    systemPurpose: systemCAPurposeEnum('system_purpose'),

    // Metadata
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationReason: varchar('revocation_reason', { length: 50 }),
  },
  (table) => ({
    parentIdx: index('ca_parent_idx').on(table.parentId),
    statusIdx: index('ca_status_idx').on(table.status),
    serialIdx: uniqueIndex('ca_serial_idx').on(table.serialNumber),
    createdByIdx: index('ca_created_by_idx').on(table.createdById),
    systemPurposeUnique: uniqueIndex('ca_system_purpose_unique').on(table.systemPurpose),
  })
);
