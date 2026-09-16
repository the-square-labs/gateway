import { boolean, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { proxyHostTypeEnum } from './proxy-enums.js';
import { users } from './users.js';

export interface TemplateVariableDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  description?: string;
}

export const nginxTemplates = pgTable('nginx_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  isBuiltin: boolean('is_builtin').notNull().default(false),
  type: proxyHostTypeEnum('type').notNull(),
  content: text('content').notNull(),
  variables: jsonb('variables').$type<TemplateVariableDef[]>().default([]),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
