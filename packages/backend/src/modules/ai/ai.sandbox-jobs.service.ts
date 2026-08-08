import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import type { NewSandboxJob, SandboxJob } from '@/db/schema/index.js';
import { sandboxJobs, users } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { computeEffectiveUserAccess, fetchGroupScopeMap } from '@/modules/auth/live-session-user.js';
import type { SandboxJobKind, SandboxJobStatus, SandboxResourceTier, SandboxRuntime } from './ai.sandbox-policy.js';

const ACTIVE_SANDBOX_STATUSES: SandboxJobStatus[] = ['queued', 'running'];

export interface CreateSandboxJobInput {
  userId: string;
  conversationId?: string | null;
  kind: SandboxJobKind;
  runtime: SandboxRuntime;
  resourceTier: SandboxResourceTier;
  requestedTtlSeconds: number;
  effectiveTtlSeconds: number;
  requiredScopes: string[];
  workspaceReservationBytes: number;
}

export interface ListSandboxJobsInput {
  userId: string;
  canManageAll: boolean;
  status?: SandboxJobStatus;
  activeOnly?: boolean;
  limit?: number;
}

export interface ListExpiredSandboxJobsInput {
  userId?: string;
  canManageAll?: boolean;
  now?: Date;
}

export class AISandboxJobsService {
  constructor(private readonly db: DrizzleClient) {}

  async create(input: CreateSandboxJobInput) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.effectiveTtlSeconds * 1000);
    const [row] = await this.db
      .insert(sandboxJobs)
      .values({
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        kind: input.kind,
        runtime: input.runtime,
        resourceTier: input.resourceTier,
        requestedTtlSeconds: input.requestedTtlSeconds,
        effectiveTtlSeconds: input.effectiveTtlSeconds,
        requiredScopes: input.requiredScopes,
        workspaceReservationBytes: input.workspaceReservationBytes,
        status: 'queued',
        expiresAt,
        updatedAt: now,
      })
      .returning();
    return row;
  }

  async get(id: string) {
    const [row] = await this.db.select().from(sandboxJobs).where(eq(sandboxJobs.id, id)).limit(1);
    if (!row) throw new AppError(404, 'SANDBOX_JOB_NOT_FOUND', 'Sandbox job not found');
    return row;
  }

  async findByContainerId(containerId: string) {
    const [row] = await this.db.select().from(sandboxJobs).where(eq(sandboxJobs.containerId, containerId)).limit(1);
    return row ?? null;
  }

  async list(input: ListSandboxJobsInput) {
    const conditions = [];
    if (!input.canManageAll) conditions.push(eq(sandboxJobs.userId, input.userId));
    if (input.status) conditions.push(eq(sandboxJobs.status, input.status));
    if (input.activeOnly) conditions.push(inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES));

    return this.db
      .select()
      .from(sandboxJobs)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(sandboxJobs.createdAt))
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  }

  async listExpiredActive(input: ListExpiredSandboxJobsInput = {}): Promise<SandboxJob[]> {
    const conditions = [
      inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES),
      lte(sandboxJobs.expiresAt, input.now ?? new Date()),
    ];
    if (!input.canManageAll && input.userId) conditions.push(eq(sandboxJobs.userId, input.userId));

    return this.db
      .select()
      .from(sandboxJobs)
      .where(and(...conditions))
      .orderBy(desc(sandboxJobs.createdAt));
  }

  async markRunning(id: string, containerId: string) {
    const now = new Date();
    return this.update(id, {
      status: 'running',
      containerId,
      startedAt: now,
      updatedAt: now,
    });
  }

  async markFinished(
    id: string,
    status: Extract<SandboxJobStatus, 'exited' | 'killed' | 'timeout' | 'failed' | 'revoked' | 'expired'>,
    updates: {
      exitCode?: number | null;
      error?: string | null;
      revocationReason?: string | null;
      outputBytes?: number;
      workspaceUsageBytes?: number;
    } = {}
  ) {
    return this.update(id, {
      status,
      exitCode: updates.exitCode ?? null,
      error: updates.error ?? null,
      revocationReason: updates.revocationReason ?? null,
      outputBytes: updates.outputBytes,
      workspaceUsageBytes: updates.workspaceUsageBytes,
      workspaceReservationReleasedAt: new Date(),
      finishedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async markFinishedIfActive(
    id: string,
    status: Extract<SandboxJobStatus, 'exited' | 'killed' | 'timeout' | 'failed' | 'revoked' | 'expired'>,
    updates: {
      exitCode?: number | null;
      error?: string | null;
      revocationReason?: string | null;
      outputBytes?: number;
      workspaceUsageBytes?: number;
    } = {}
  ) {
    const now = new Date();
    const [row] = await this.db
      .update(sandboxJobs)
      .set({
        status,
        exitCode: updates.exitCode ?? null,
        error: updates.error ?? null,
        revocationReason: updates.revocationReason ?? null,
        outputBytes: updates.outputBytes,
        workspaceUsageBytes: updates.workspaceUsageBytes,
        workspaceReservationReleasedAt: now,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(sandboxJobs.id, id), inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES)))
      .returning();
    return row ?? null;
  }

  async update(id: string, values: Partial<NewSandboxJob>) {
    const [row] = await this.db.update(sandboxJobs).set(values).where(eq(sandboxJobs.id, id)).returning();
    if (!row) throw new AppError(404, 'SANDBOX_JOB_NOT_FOUND', 'Sandbox job not found');
    return row;
  }

  async listActiveForUser(userId: string) {
    return this.db
      .select()
      .from(sandboxJobs)
      .where(and(eq(sandboxJobs.userId, userId), inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES)));
  }

  async listActiveForConversation(userId: string, conversationId: string) {
    return this.db
      .select()
      .from(sandboxJobs)
      .where(
        and(
          eq(sandboxJobs.userId, userId),
          eq(sandboxJobs.conversationId, conversationId),
          inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES)
        )
      );
  }

  async listActiveWithEffectiveScopes() {
    const groupMap = await fetchGroupScopeMap(this.db);
    const rows = await this.db
      .select({
        job: sandboxJobs,
        user: {
          id: users.id,
          groupId: users.groupId,
          additionalScopes: users.additionalScopes,
          isBlocked: users.isBlocked,
          deletedAt: users.deletedAt,
        },
      })
      .from(sandboxJobs)
      .innerJoin(users, eq(sandboxJobs.userId, users.id))
      .where(inArray(sandboxJobs.status, ACTIVE_SANDBOX_STATUSES));

    return rows.map((row) => ({
      job: row.job,
      userId: row.user.id,
      currentScopes:
        row.user.isBlocked || row.user.deletedAt
          ? []
          : computeEffectiveUserAccess(row.user.groupId, groupMap, row.user.additionalScopes).scopes,
    }));
  }
}
