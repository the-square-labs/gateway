import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { keyAlgorithmEnum } from './certificate-authorities.js';
import { certTypeEnum } from './certificates.js';
import { pkiTemplateFolders } from './pki-folders.js';
import { users } from './users.js';

export const certificateTemplates = pgTable(
  'certificate_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    isBuiltin: boolean('is_builtin').notNull().default(false),

    // Template configuration
    certType: certTypeEnum('cert_type').notNull(),
    keyAlgorithm: keyAlgorithmEnum('key_algorithm').notNull().default('ecdsa-p256'),
    validityDays: integer('validity_days').notNull().default(365),
    keyUsage: jsonb('key_usage').$type<string[]>().notNull(),
    extKeyUsage: jsonb('ext_key_usage').$type<string[]>().notNull(),

    // Subject constraints
    requireSans: boolean('require_sans').notNull().default(true),
    sanTypes: jsonb('san_types').$type<string[]>().default(['dns', 'ip']),

    // Subject DN defaults
    subjectDnFields: jsonb('subject_dn_fields')
      .$type<{
        o?: string;
        ou?: string;
        l?: string;
        st?: string;
        c?: string;
        serialNumber?: string;
      }>()
      .default({}),

    // Distribution points
    crlDistributionPoints: jsonb('crl_distribution_points').$type<string[]>().default([]),
    authorityInfoAccess: jsonb('authority_info_access')
      .$type<{
        ocspUrl?: string;
        caIssuersUrl?: string;
      }>()
      .default({}),

    // Policies
    certificatePolicies: jsonb('certificate_policies')
      .$type<
        {
          oid: string;
          qualifier?: string;
        }[]
      >()
      .default([]),

    // Custom extensions
    customExtensions: jsonb('custom_extensions')
      .$type<
        {
          oid: string;
          critical: boolean;
          value: string;
        }[]
      >()
      .default([]),

    // Metadata
    createdById: uuid('created_by_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    // Custom templates only; built-ins stay in the read-only built-in group.
    folderId: uuid('folder_id').references((): AnyPgColumn => pkiTemplateFolders.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    folderIdx: index('cert_template_folder_idx').on(table.folderId),
  })
);
