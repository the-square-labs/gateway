import type { dockerMigrations } from '@/db/schema/index.js';
export type MigrationRow = typeof dockerMigrations.$inferSelect;
export interface StoredMigrationPlan extends Record<string, unknown> {
  manifest?: Record<string, any>;
  deployment?: Record<string, any>;
  deploymentManifests?: Record<string, Record<string, any>>;
  encryptedExecutionPlan?: {
    encryptedKey: string;
    encryptedDek: string;
  };
  deploymentActiveSlot?: string;
  target?: Record<string, string>;
  targetNodeSlug?: string;
  plannedChanges?: string[];
  verificationPlan?: string[];
  environmentKeyCount?: number;
  secretKeyCount?: number;
}
