import { eq } from 'drizzle-orm';
import { injectable } from 'tsyringe';
import type { DrizzleClient } from '@/db/client.js';
import { INFERENCE_CORE_STATE_ID, type InferenceCoreStateRow, inferenceCoreState } from '@/db/schema/inference-core.js';
import { settings } from '@/db/schema/settings.js';

/** Persisted "latest release" discovery blob (settings table). */
export interface InferenceCoreLatestInfo {
  version: string;
  digest: string;
  sizeBytes: number;
  releaseNotesUrl: string | null;
  checkedAt: string;
}

const LATEST_SETTINGS_KEY = 'inference-core:latest';

/**
 * Thin persistence boundary for the managed core singleton state. Kept
 * separate from the runtime engine so lifecycle tests can substitute an
 * in-memory store without mocking drizzle query chains.
 */
@injectable()
export class InferenceCoreStore {
  constructor(private readonly db: DrizzleClient) {}

  async loadState(): Promise<InferenceCoreStateRow | null> {
    const rows = await this.db
      .select()
      .from(inferenceCoreState)
      .where(eq(inferenceCoreState.id, INFERENCE_CORE_STATE_ID))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertState(patch: Partial<typeof inferenceCoreState.$inferInsert>): Promise<void> {
    await this.db
      .insert(inferenceCoreState)
      .values({ id: INFERENCE_CORE_STATE_ID, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: inferenceCoreState.id,
        set: { ...patch, updatedAt: new Date() },
      });
  }

  async loadLatestInfo(): Promise<InferenceCoreLatestInfo | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, LATEST_SETTINGS_KEY)).limit(1);
    const value = rows[0]?.value as InferenceCoreLatestInfo | undefined;
    return value && typeof value.version === 'string' ? value : null;
  }

  async storeLatestInfo(info: InferenceCoreLatestInfo | null): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key: LATEST_SETTINGS_KEY, value: info, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: info, updatedAt: new Date() } });
  }
}
