import { sql } from 'drizzle-orm';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient, DrizzleTransaction } from '@/db/client.js';

@injectable()
export class InferenceBudgetLockService {
  constructor(@inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient) {}

  async withUserLock<T>(userId: string, work: (tx: DrizzleTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      return work(tx);
    });
  }

  async lockProviderConnection(database: DrizzleTransaction, connectionId: string): Promise<void> {
    await database.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inference-provider:${connectionId}`}, 0))`
    );
  }
}
