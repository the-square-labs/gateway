import { type AnyPgColumn, index, integer, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** Folders of root CAs. A root CA's intermediates are listed with it, so only roots carry a folder. */
export const pkiCaFolders = pgTable(
  'pki_ca_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => pkiCaFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('pki_ca_folder_parent_idx').on(table.parentId),
    sortIdx: index('pki_ca_folder_sort_idx').on(table.parentId, table.sortOrder),
  })
);

export const pkiCertificateFolders = pgTable(
  'pki_certificate_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => pkiCertificateFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('pki_certificate_folder_parent_idx').on(table.parentId),
    sortIdx: index('pki_certificate_folder_sort_idx').on(table.parentId, table.sortOrder),
  })
);

/** Folders of custom certificate templates. Built-in templates never carry a folder. */
export const pkiTemplateFolders = pgTable(
  'pki_template_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => pkiTemplateFolders.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    depth: integer('depth').notNull().default(0),
    createdById: uuid('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    parentIdx: index('pki_template_folder_parent_idx').on(table.parentId),
    sortIdx: index('pki_template_folder_sort_idx').on(table.parentId, table.sortOrder),
  })
);
