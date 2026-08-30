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
import { certificates } from './certificates.js';
import { sslCertificateFolders } from './ssl-certificate-folders.js';
import { users } from './users.js';

export const sslCertTypeEnum = pgEnum('ssl_cert_type', ['acme', 'upload', 'internal']);
export const sslCertStatusEnum = pgEnum('ssl_cert_status', ['active', 'expired', 'pending', 'error']);
export const acmeChallengeEnum = pgEnum('acme_challenge_type', ['http-01', 'dns-01']);

export const sslCertificates = pgTable(
  'ssl_certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    type: sslCertTypeEnum('type').notNull(),
    domainNames: jsonb('domain_names').$type<string[]>().notNull().default([]),

    // Certificate data
    certificatePem: text('certificate_pem'),
    privateKeyPem: text('private_key_pem'), // encrypted via envelope encryption
    encryptedDek: text('encrypted_dek'),
    dekIv: text('dek_iv'),
    chainPem: text('chain_pem'),

    // ACME specific
    acmeProvider: varchar('acme_provider', { length: 50 }), // 'letsencrypt', 'letsencrypt-staging'
    acmeChallengeType: acmeChallengeEnum('acme_challenge_type'),
    acmeAccountKey: text('acme_account_key'), // encrypted
    acmeOrderUrl: text('acme_order_url'),
    acmePendingOperation: varchar('acme_pending_operation', { length: 20 }), // 'issue' | 'renewal'
    acmePendingChallenges:
      jsonb('acme_pending_challenges').$type<
        Array<{
          domain: string;
          recordName: string;
          recordValue: string;
          cloudflare?: {
            connectorId: string;
            zoneId: string;
            zoneName: string;
            recordId: string;
            created: boolean;
          };
        }>
      >(),

    // Internal CA link — references existing PKI cert
    internalCertId: uuid('internal_cert_id').references(() => certificates.id, { onDelete: 'set null' }),

    // Validity
    notBefore: timestamp('not_before', { withTimezone: true }),
    notAfter: timestamp('not_after', { withTimezone: true }),
    autoRenew: boolean('auto_renew').notNull().default(false),
    autoRenewProvider: varchar('auto_renew_provider', { length: 50 }).$type<'cloudflare'>(),
    autoRenewDnsBindings:
      jsonb('auto_renew_dns_bindings').$type<
        Array<{
          domain: string;
          connectorId: string;
          connectorName: string;
          zoneId: string;
          zoneName: string;
        }>
      >(),
    autoRenewDisabledReason: text('auto_renew_disabled_reason'),
    autoRenewDisabledAt: timestamp('auto_renew_disabled_at', { withTimezone: true }),
    lastRenewedAt: timestamp('last_renewed_at', { withTimezone: true }),
    renewalError: text('renewal_error'),

    // Status
    status: sslCertStatusEnum('status').notNull().default('pending'),

    // System flag — locked certs cannot be deleted (e.g. management domain cert)
    isSystem: boolean('is_system').notNull().default(false),
    folderId: uuid('folder_id').references((): AnyPgColumn => sslCertificateFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),

    // Metadata
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index('ssl_cert_status_idx').on(table.status),
    notAfterIdx: index('ssl_cert_not_after_idx').on(table.notAfter),
    typeIdx: index('ssl_cert_type_idx').on(table.type),
    autoRenewProviderIdx: index('ssl_cert_auto_renew_provider_idx').on(table.autoRenewProvider),
    createdByIdx: index('ssl_cert_created_by_idx').on(table.createdById),
    folderIdx: index('ssl_cert_folder_idx').on(table.folderId),
  })
);
