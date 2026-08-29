import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import { aiPlanRevisions } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';

export async function requireAcceptedRevision(db: DrizzleExecutor, planId: string) {
  const [revision] = await db
    .select()
    .from(aiPlanRevisions)
    .where(and(eq(aiPlanRevisions.planId, planId), eq(aiPlanRevisions.status, 'accepted')))
    .orderBy(desc(aiPlanRevisions.revision))
    .limit(1);
  if (!revision) throw new AppError(409, 'AI_PLAN_REVISION_NOT_ACCEPTED', 'No accepted plan revision exists');
  return revision;
}
