import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type AICredentialChallenge,
  type AIRun,
  type AIRunPurpose,
  type AIRunQuestion,
  type AIRunToolCall,
  aiConversationInputs,
  aiConversationMessages,
  aiConversations,
  aiPlanRevisions,
  aiPlans,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRunSetupInteractions,
  aiRuns,
  aiRunToolCalls,
  aiRunToolRounds,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import type { AIPlanRuntimeSnapshot } from './ai.types.js';
import {
  countVisibleMessages,
  deriveConversationStatus,
  getLastUserMessageAt,
  isHiddenSystemMessage,
} from './ai-conversation.service.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import type { AIPlanService } from './ai-plan.service.js';
import {
  ACTIVE_PLAN_STATUSES,
  ACTIVE_RUN_STATUSES,
  type AIAssistantCommentDeltaEvent,
  type AIAssistantCommentDoneEvent,
  type AIAssistantDeltaEvent,
  type AIClientActionEvent,
  type AIConversationChangedEvent,
  type AIConversationRuntimeSnapshot,
  type AICredentialRequiredEvent,
  aiUserConversationsChangedChannel,
  assertOwnedConversation,
  collectResourceReferences,
  findRunByCommand,
  findRunByUserCommand,
  getOwnedConversation,
  nextMessageSequence,
  PRE_EXECUTION_PLAN_STATUSES,
  questionIdentityWhere,
  type RuntimeSnapshot,
  readMessageRole,
  toConversationMessage,
  toolCallIdentityWhere,
  toSnapshotMessage,
  withAssistantDraftMessage,
} from './ai-run.shared.js';
import { AIRunExecutor } from './ai-run-executor.js';
import { toClientCheckpoint } from './ai-run-runtime.helpers.js';

export abstract class AIRunServiceRuntime {
  protected readonly executor: AIRunExecutor;

  constructor(
    protected readonly db: DrizzleClient,
    protected readonly eventBus?: EventBusService,
    protected readonly conversationSearchService?: AIConversationSearchService,
    protected readonly planService?: AIPlanService
  ) {
    this.executor = new AIRunExecutor(
      db,
      (userId, conversationId, invalidatedStores) =>
        this.publishConversationChanged(userId, conversationId, invalidatedStores),
      (userId, conversationId, runId, content, version) =>
        this.publishAssistantDelta(userId, conversationId, runId, content, version),
      (userId, conversationId, runId, content, version) =>
        this.publishAssistantCommentDelta(userId, conversationId, runId, content, version),
      (userId, conversationId, runId) => this.publishAssistantCommentDone(userId, conversationId, runId),
      conversationSearchService,
      (userId, conversationId, runId, challenge) =>
        this.publishCredentialChallenge(userId, conversationId, runId, challenge),
      (userId, conversationId, runId, action) => this.publishClientAction(userId, conversationId, runId, action),
      (user, run) => this.handleCompletedRun(user, run),
      (user, run, error) => this.handleFailedRun(user, run, error)
    );
  }

  protected abstract startPlanRun(input: {
    user: User;
    plan: AIPlanRuntimeSnapshot;
    purpose: Exclude<AIRunPurpose, 'direct'>;
    clientCommandId: string;
    instruction?: string;
  }): Promise<{ run: AIRun; duplicate: boolean }>;

  protected abstract getActiveRun(conversationId: string): Promise<AIRun | null>;

  protected abstract resumeResolvedCredentialContinuation(
    user: User,
    input: { conversationId: string; runId: string }
  ): Promise<boolean>;

  async stopRun(input: {
    conversationId: string;
    runId: string;
    userId: string;
  }): Promise<{ run: AIRun; duplicate: boolean }> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const now = new Date();

    const [current] = await this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, input.runId),
          eq(aiRuns.conversationId, input.conversationId),
          eq(aiRuns.userId, input.userId)
        )
      )
      .limit(1);
    if (!current) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    const [stopped] = await this.db
      .update(aiRuns)
      .set({
        status: 'stopped',
        error: null,
        stoppedAt: now,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiRuns.id, input.runId),
          eq(aiRuns.conversationId, input.conversationId),
          eq(aiRuns.userId, input.userId),
          inArray(aiRuns.status, ACTIVE_RUN_STATUSES)
        )
      )
      .returning();

    if (stopped) {
      this.executor.abortRun(input.runId);
      await this.executor.flushAssistantDraftToMessage(
        input.userId,
        input.conversationId,
        input.runId,
        stopped.assistantDraftContent
      );
      await Promise.all([
        this.db
          .update(aiRunToolRounds)
          .set({ status: 'stopped', completedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunToolRounds.runId, input.runId),
              inArray(aiRunToolRounds.status, [
                'collecting',
                'waiting_questions',
                'waiting_approvals',
                'waiting_setup',
                'ready',
                'executing',
              ])
            )
          ),
        this.db
          .update(aiRunToolCalls)
          .set({ status: 'stopped', updatedAt: now })
          .where(
            and(
              eq(aiRunToolCalls.runId, input.runId),
              eq(aiRunToolCalls.conversationId, input.conversationId),
              inArray(aiRunToolCalls.status, ['created', 'pending_approval', 'approved', 'running'])
            )
          ),
        this.db
          .update(aiRunQuestions)
          .set({ status: 'stopped', updatedAt: now })
          .where(
            and(
              eq(aiRunQuestions.runId, input.runId),
              eq(aiRunQuestions.conversationId, input.conversationId),
              eq(aiRunQuestions.status, 'pending')
            )
          ),
        this.db
          .update(aiRunCredentialChallenges)
          .set({ status: 'stopped', resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunCredentialChallenges.runId, input.runId),
              eq(aiRunCredentialChallenges.conversationId, input.conversationId),
              eq(aiRunCredentialChallenges.status, 'pending')
            )
          ),
        this.db
          .update(aiRunSetupInteractions)
          .set({ status: 'stopped', resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunSetupInteractions.runId, input.runId),
              eq(aiRunSetupInteractions.conversationId, input.conversationId),
              eq(aiRunSetupInteractions.status, 'pending')
            )
          ),
        this.db
          .update(aiConversationInputs)
          .set({ mode: 'queued', targetRunId: null, updatedAt: now })
          .where(
            and(
              eq(aiConversationInputs.conversationId, input.conversationId),
              eq(aiConversationInputs.targetRunId, input.runId),
              eq(aiConversationInputs.userId, input.userId),
              eq(aiConversationInputs.mode, 'steer'),
              eq(aiConversationInputs.status, 'pending')
            )
          ),
      ]);
      if (this.planService && stopped.planId) {
        await this.planService.recoverStoppedPlanRun(
          input.userId,
          input.conversationId,
          stopped.planId,
          stopped.purpose,
          'Plan run stopped by user'
        );
      }
      this.publishConversationChanged(input.userId, input.conversationId);
      return { run: stopped, duplicate: false };
    }

    // Stop is an idempotent user intent. The UI can race with a terminal snapshot, so a
    // completed or otherwise terminal run is already in the desired non-active state.
    return { run: current, duplicate: true };
  }

  async stopAllForShutdown(): Promise<void> {
    const activeRuns = await this.db
      .select({
        id: aiRuns.id,
        conversationId: aiRuns.conversationId,
        userId: aiRuns.userId,
        status: aiRuns.status,
        planId: aiRuns.planId,
        purpose: aiRuns.purpose,
        assistantDraftContent: aiRuns.assistantDraftContent,
      })
      .from(aiRuns)
      .where(inArray(aiRuns.status, ACTIVE_RUN_STATUSES));
    await Promise.allSettled(
      activeRuns.map(async (run) => {
        this.executor.abortRun(run.id);
        await this.executor.flushAssistantDraftToMessage(
          run.userId,
          run.conversationId,
          run.id,
          run.assistantDraftContent
        );
        if (run.status === 'running') {
          const effectUnknown = await this.reconcileInterruptedRunningRun(run);
          if (effectUnknown) {
            await this.pausePlanAfterFailedRun(
              run,
              'Gateway restarted while a plan tool was running. Verify the real resource state before resuming.'
            );
          }
        } else {
          await this.db
            .update(aiRuns)
            .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
            .where(eq(aiRuns.id, run.id));
        }
        this.publishConversationChanged(run.userId, run.conversationId);
      })
    );
  }

  async recoverInterruptedRuns(loadUser: (userId: string) => Promise<User | null>): Promise<void> {
    const runs = await this.db.select().from(aiRuns).where(inArray(aiRuns.status, ACTIVE_RUN_STATUSES));
    for (const run of runs) {
      if (run.status === 'running') {
        const effectUnknown = await this.reconcileInterruptedRunningRun(run);
        if (effectUnknown) {
          await this.pausePlanAfterFailedRun(
            run,
            'Gateway restarted while a plan tool was running. Verify the real resource state before resuming.'
          );
        }
      }
      const [current] = await this.db.select().from(aiRuns).where(eq(aiRuns.id, run.id)).limit(1);
      if (!current) continue;
      if (current.status === 'waiting_for_approval' || current.status === 'waiting_for_answer') {
        const [readyRound] = await this.db
          .select({ id: aiRunToolRounds.id })
          .from(aiRunToolRounds)
          .where(and(eq(aiRunToolRounds.runId, run.id), eq(aiRunToolRounds.status, 'ready')))
          .orderBy(desc(aiRunToolRounds.sequence))
          .limit(1);
        if (!readyRound) continue;
        const user = await loadUser(run.userId).catch(() => null);
        if (user && !user.isBlocked) {
          this.executor.startToolRoundContinuation(user, {
            conversationId: run.conversationId,
            runId: run.id,
            roundId: readyRound.id,
          });
        }
        continue;
      }
      if (current.status === 'waiting_for_credential') {
        const user = await loadUser(run.userId).catch(() => null);
        if (user && !user.isBlocked) {
          await this.resumeResolvedCredentialContinuation(user, {
            conversationId: run.conversationId,
            runId: run.id,
          });
        }
        continue;
      }
      if (current.status !== 'queued') continue;
      const user = await loadUser(run.userId).catch(() => null);
      if (!user || user.isBlocked) {
        await this.db
          .update(aiRuns)
          .set({
            status: 'failed',
            error: 'PERMISSION_DENIED: Current account access could not be verified after restart.',
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(aiRuns.id, run.id));
        this.publishConversationChanged(run.userId, run.conversationId);
        continue;
      }
      if (current.activeMessageId === null) {
        this.executor.startContextCompaction(user, run.id, 'manual');
      } else {
        this.executor.startRunExecution(user, run.id);
      }
    }

    const pendingInputs = await this.db
      .select({
        conversationId: aiConversationInputs.conversationId,
        userId: aiConversationInputs.userId,
        targetRunId: aiConversationInputs.targetRunId,
      })
      .from(aiConversationInputs)
      .where(eq(aiConversationInputs.status, 'pending'))
      .orderBy(asc(aiConversationInputs.createdAt));
    const recoveredConversations = new Set<string>();
    for (const pending of pendingInputs) {
      if (recoveredConversations.has(pending.conversationId)) continue;
      if (await this.getActiveRun(pending.conversationId)) continue;
      if (await this.planService?.getActivePlanSnapshot(pending.userId, pending.conversationId)) continue;
      if (pending.targetRunId) {
        const [targetRun] = await this.db
          .select({ status: aiRuns.status })
          .from(aiRuns)
          .where(eq(aiRuns.id, pending.targetRunId))
          .limit(1);
        if (targetRun?.status !== 'completed') {
          if (targetRun && (targetRun.status === 'failed' || targetRun.status === 'stopped')) {
            await this.db
              .update(aiConversationInputs)
              .set({ mode: 'queued', targetRunId: null, updatedAt: new Date() })
              .where(
                and(
                  eq(aiConversationInputs.conversationId, pending.conversationId),
                  eq(aiConversationInputs.targetRunId, pending.targetRunId),
                  eq(aiConversationInputs.mode, 'steer'),
                  eq(aiConversationInputs.status, 'pending')
                )
              );
          }
          continue;
        }
      }
      const user = await loadUser(pending.userId).catch(() => null);
      if (!user || user.isBlocked) continue;
      recoveredConversations.add(pending.conversationId);
      this.executor.startPendingInputExecution(user, pending.conversationId);
    }

    if (this.planService) {
      for (const owner of await this.planService.listRecoverablePlans()) {
        if (await this.getActiveRun(owner.conversationId)) continue;
        const user = await loadUser(owner.userId).catch(() => null);
        if (!user || user.isBlocked) continue;
        const plan = await this.planService.getActivePlanSnapshot(owner.userId, owner.conversationId);
        if (!plan) continue;
        await this.schedulePlanStateRun(user, plan, `recovery:${Date.now()}`);
      }
    }
  }

  protected async reconcileInterruptedRunningRun(
    run: Pick<AIRun, 'id' | 'conversationId' | 'userId'>
  ): Promise<boolean> {
    const runningCalls = await this.db
      .select({ id: aiRunToolCalls.id, roundId: aiRunToolCalls.roundId })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, run.id), eq(aiRunToolCalls.status, 'running')));
    const now = new Date();
    if (runningCalls.length > 0) {
      const error =
        'AI_TOOL_EFFECT_UNKNOWN: Gateway restarted while a tool was running. Verify the real resource state before retrying.';
      await this.db
        .update(aiRunToolCalls)
        .set({ status: 'effect_unknown', error, completedAt: now, updatedAt: now })
        .where(and(eq(aiRunToolCalls.runId, run.id), eq(aiRunToolCalls.status, 'running')));
      const roundIds = runningCalls.flatMap((call) => (call.roundId ? [call.roundId] : []));
      if (roundIds.length > 0) {
        await this.db
          .update(aiRunToolRounds)
          .set({ status: 'failed', error, completedAt: now, updatedAt: now })
          .where(inArray(aiRunToolRounds.id, roundIds));
      }
      await this.db
        .update(aiRuns)
        .set({
          status: 'failed',
          error,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(aiRuns.id, run.id));
      return true;
    }
    await this.db
      .update(aiRuns)
      .set({
        status: 'queued',
        error: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        stoppedAt: null,
        updatedAt: now,
      })
      .where(eq(aiRuns.id, run.id));
    return false;
  }

  waitForIdle(deadline: number): Promise<void> {
    return this.executor.waitForIdle(deadline);
  }

  async stopActiveRunForRollback(input: {
    conversationId: string;
    userId: string;
  }): Promise<{ run: AIRun; duplicate: boolean } | null> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const activeRun = await this.getActiveRun(input.conversationId);
    if (!activeRun) return null;
    try {
      return await this.stopRun({
        conversationId: input.conversationId,
        runId: activeRun.id,
        userId: input.userId,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'AI_RUN_NOT_ACTIVE') return null;
      throw error;
    }
  }

  async abandonPlanning(input: {
    conversationId: string;
    userId: string;
    clientCommandId: string;
  }): Promise<{ duplicate: boolean; stoppedRunId: string | null; deletedPlanId: string | null }> {
    const result = await this.db.transaction(async (tx) => {
      const [conversation] = await tx
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.userId, input.userId)))
        .for('update');
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

      const [existingReceipt] = await tx
        .select({ id: aiConversationMessages.id })
        .from(aiConversationMessages)
        .where(
          and(
            eq(aiConversationMessages.conversationId, input.conversationId),
            eq(aiConversationMessages.role, 'system'),
            sql`${aiConversationMessages.uiMessage}->'lifecycleEvent'->>'type' = 'planning_cancelled'`,
            sql`${aiConversationMessages.uiMessage}->'lifecycleEvent'->>'clientCommandId' = ${input.clientCommandId}`
          )
        )
        .limit(1);
      if (existingReceipt) {
        return { duplicate: true, stoppedRunId: null, deletedPlanId: null };
      }

      const [plan] = await tx
        .select()
        .from(aiPlans)
        .where(
          and(
            eq(aiPlans.userId, input.userId),
            eq(aiPlans.conversationId, input.conversationId),
            inArray(aiPlans.status, ACTIVE_PLAN_STATUSES)
          )
        )
        .orderBy(desc(aiPlans.createdAt))
        .limit(1)
        .for('update');
      if (plan && !PRE_EXECUTION_PLAN_STATUSES.includes(plan.status)) {
        throw new AppError(
          409,
          'AI_PLAN_ALREADY_EXECUTING',
          'Use the existing plan controls to pause or cancel an executing plan'
        );
      }

      const [publishedRevision] = plan
        ? await tx
            .select()
            .from(aiPlanRevisions)
            .where(and(eq(aiPlanRevisions.planId, plan.id), isNotNull(aiPlanRevisions.publishedAt)))
            .orderBy(desc(aiPlanRevisions.revision))
            .limit(1)
            .for('update')
        : [];

      const [activeRun] = await tx
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.userId, input.userId),
            eq(aiRuns.conversationId, input.conversationId),
            inArray(aiRuns.status, ACTIVE_RUN_STATUSES)
          )
        )
        .orderBy(desc(aiRuns.createdAt))
        .limit(1)
        .for('update');
      const now = new Date();
      let stoppedRunId: string | null = null;
      if (activeRun) {
        const [stopped] = await tx
          .update(aiRuns)
          .set({
            status: 'stopped',
            error: null,
            assistantDraftContent: null,
            stoppedAt: now,
            completedAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(aiRuns.id, activeRun.id),
              eq(aiRuns.userId, input.userId),
              eq(aiRuns.conversationId, input.conversationId),
              inArray(aiRuns.status, ACTIVE_RUN_STATUSES)
            )
          )
          .returning({ id: aiRuns.id });
        if (!stopped) {
          throw new AppError(409, 'AI_PLANNING_STATE_CHANGED', 'Planning state changed while it was being cancelled');
        }
        stoppedRunId = stopped.id;
        await tx
          .update(aiRunToolRounds)
          .set({ status: 'stopped', completedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunToolRounds.runId, stopped.id),
              inArray(aiRunToolRounds.status, [
                'collecting',
                'waiting_questions',
                'waiting_approvals',
                'waiting_setup',
                'ready',
                'executing',
              ])
            )
          );
        await tx
          .update(aiRunToolCalls)
          .set({ status: 'stopped', updatedAt: now })
          .where(
            and(
              eq(aiRunToolCalls.runId, stopped.id),
              eq(aiRunToolCalls.conversationId, input.conversationId),
              inArray(aiRunToolCalls.status, ['created', 'pending_approval', 'approved', 'running'])
            )
          );
        await tx
          .update(aiRunQuestions)
          .set({ status: 'stopped', updatedAt: now })
          .where(
            and(
              eq(aiRunQuestions.runId, stopped.id),
              eq(aiRunQuestions.conversationId, input.conversationId),
              eq(aiRunQuestions.status, 'pending')
            )
          );
        await tx
          .update(aiRunCredentialChallenges)
          .set({ status: 'stopped', resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunCredentialChallenges.runId, stopped.id),
              eq(aiRunCredentialChallenges.conversationId, input.conversationId),
              eq(aiRunCredentialChallenges.status, 'pending')
            )
          );
        await tx
          .update(aiRunSetupInteractions)
          .set({ status: 'stopped', resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(aiRunSetupInteractions.runId, stopped.id),
              eq(aiRunSetupInteractions.conversationId, input.conversationId),
              eq(aiRunSetupInteractions.status, 'pending')
            )
          );
        await tx
          .update(aiConversationInputs)
          .set({ mode: 'queued', targetRunId: null, updatedAt: now })
          .where(
            and(
              eq(aiConversationInputs.conversationId, input.conversationId),
              eq(aiConversationInputs.targetRunId, stopped.id),
              eq(aiConversationInputs.userId, input.userId),
              eq(aiConversationInputs.mode, 'steer'),
              eq(aiConversationInputs.status, 'pending')
            )
          );
      }

      let deletedPlanId: string | null = null;
      if (plan) {
        if (publishedRevision) {
          await tx
            .delete(aiPlanRevisions)
            .where(and(eq(aiPlanRevisions.planId, plan.id), isNull(aiPlanRevisions.publishedAt)));
          await tx
            .update(aiPlanRevisions)
            .set({
              status: 'published',
              decision: null,
              customInstruction: null,
              decisionClientCommandId: null,
              acceptedAt: null,
              decisionAt: null,
              updatedAt: now,
            })
            .where(eq(aiPlanRevisions.id, publishedRevision.id));
          const [restored] = await tx
            .update(aiPlans)
            .set({
              status: 'awaiting_decision',
              activeSince: null,
              pauseReason: null,
              noProgressRuns: 0,
              updatedAt: now,
            })
            .where(
              and(
                eq(aiPlans.id, plan.id),
                eq(aiPlans.userId, input.userId),
                eq(aiPlans.conversationId, input.conversationId),
                inArray(aiPlans.status, PRE_EXECUTION_PLAN_STATUSES)
              )
            )
            .returning({ id: aiPlans.id });
          if (!restored) {
            throw new AppError(409, 'AI_PLANNING_STATE_CHANGED', 'Planning state changed while it was being cancelled');
          }
        } else {
          const [deleted] = await tx
            .delete(aiPlans)
            .where(
              and(
                eq(aiPlans.id, plan.id),
                eq(aiPlans.userId, input.userId),
                eq(aiPlans.conversationId, input.conversationId),
                inArray(aiPlans.status, PRE_EXECUTION_PLAN_STATUSES)
              )
            )
            .returning({ id: aiPlans.id });
          if (!deleted) {
            throw new AppError(409, 'AI_PLANNING_STATE_CHANGED', 'Planning state changed while it was being cancelled');
          }
          deletedPlanId = deleted.id;
        }
      }

      await tx
        .update(aiConversations)
        .set({ checkpoint: null, updatedAt: now })
        .where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.userId, input.userId)));
      const sequence = await nextMessageSequence(tx, input.conversationId);
      await tx.insert(aiConversationMessages).values(
        toConversationMessage(
          input.conversationId,
          {
            role: 'system',
            content: publishedRevision
              ? 'The user left Plan Mode. The active planning run and unfinished revision were discarded. The last published plan remains available, but do not continue revising or execute it unless the user explicitly asks.'
              : 'The user cancelled Plan Mode. The unfinished plan and planning run were discarded. Do not continue or revive that plan unless the user explicitly asks to plan again.',
            hiddenSystemEvent: true,
            lifecycleEvent: { type: 'planning_cancelled', clientCommandId: input.clientCommandId },
          },
          sequence
        )
      );
      return { duplicate: false, stoppedRunId, deletedPlanId };
    });
    if (result.stoppedRunId) this.executor.abortRun(result.stoppedRunId);
    this.publishConversationChanged(input.userId, input.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(input.userId, input.conversationId);
    return result;
  }

  startRunExecution(user: User, runId: string): void {
    this.executor.startRunExecution(user, runId);
  }

  startPendingInputExecution(user: User, conversationId: string): void {
    this.executor.startPendingInputExecution(user, conversationId);
  }

  startContextCompaction(user: User, runId: string, trigger: 'manual' | 'auto'): void {
    this.executor.startContextCompaction(user, runId, trigger);
  }

  protected async handleCompletedRun(user: User, run: AIRun): Promise<boolean> {
    if (!this.planService) return false;
    let plan = await this.planService.getActivePlanSnapshot(user.id, run.conversationId);
    if (!plan) return false;

    if (plan.status === 'pause_requested') {
      await this.planService.completePauseRequest(user.id, run.conversationId);
      return true;
    }

    if (plan.status === 'executing' && run.purpose === 'plan_execution') {
      const progressCalls = await this.db
        .select({ status: aiRunToolCalls.status, result: aiRunToolCalls.result })
        .from(aiRunToolCalls)
        .where(and(eq(aiRunToolCalls.runId, run.id), eq(aiRunToolCalls.toolName, 'update_plan_step')));
      plan =
        (await this.planService.recordExecutionRunOutcome(
          user.id,
          run.conversationId,
          progressCalls.some(
            (call) =>
              call.status === 'completed' &&
              !!call.result &&
              typeof call.result === 'object' &&
              !Array.isArray(call.result) &&
              (call.result as Record<string, unknown>).progressMade === true
          )
        )) ?? plan;
    }

    if (plan.status === 'verifying' && run.purpose === 'plan_verification') {
      const verificationCalls = await this.db
        .select({ status: aiRunToolCalls.status })
        .from(aiRunToolCalls)
        .where(and(eq(aiRunToolCalls.runId, run.id), eq(aiRunToolCalls.toolName, 'submit_plan_verification')));
      if (verificationCalls.some((call) => call.status === 'completed')) {
        await this.planService.completeFinalVerificationAfterRun(user.id, run.conversationId);
        return true;
      }
    }

    if (plan.status === 'drafting' && run.purpose === 'plan_draft') return true;
    if (plan.status === 'awaiting_decision' || plan.status === 'paused') return true;
    await this.schedulePlanStateRun(user, plan, run.id);
    return true;
  }

  protected async handleFailedRun(_user: User, run: AIRun, error: string): Promise<void> {
    if (this.planService && run.planId && run.purpose === 'plan_validation') {
      const recovered = await this.planService.recoverFailedValidation(
        run.userId,
        run.conversationId,
        run.planId,
        `Plan validation failed: ${error}`.slice(0, 1000)
      );
      if (recovered) this.publishConversationChanged(run.userId, run.conversationId);
      return;
    }
    await this.pausePlanAfterFailedRun(run, `AI run failed: ${error}`);
  }

  protected async pausePlanAfterFailedRun(
    run: Pick<AIRun, 'conversationId' | 'userId' | 'planId' | 'purpose'>,
    reason: string
  ): Promise<boolean> {
    if (!this.planService || !run.planId || (run.purpose !== 'plan_execution' && run.purpose !== 'plan_verification')) {
      return false;
    }
    const plan = await this.planService.getActivePlanSnapshot(run.userId, run.conversationId);
    if (
      !plan ||
      plan.id !== run.planId ||
      (plan.status !== 'executing' && plan.status !== 'pause_requested' && plan.status !== 'verifying')
    ) {
      return false;
    }
    if (plan.status === 'pause_requested') {
      await this.planService.completePauseRequest(run.userId, run.conversationId);
      this.publishConversationChanged(run.userId, run.conversationId);
      return true;
    }
    await this.planService.pause(run.userId, run.conversationId, reason.slice(0, 1000));
    this.publishConversationChanged(run.userId, run.conversationId);
    return true;
  }

  protected async schedulePlanStateRun(user: User, plan: AIPlanRuntimeSnapshot, triggerId: string): Promise<void> {
    const purpose =
      plan.status === 'drafting'
        ? 'plan_draft'
        : plan.status === 'validating'
          ? 'plan_validation'
          : plan.status === 'executing'
            ? 'plan_execution'
            : plan.status === 'verifying'
              ? 'plan_verification'
              : null;
    if (!purpose) return;
    await this.startPlanRun({
      user,
      plan,
      purpose,
      clientCommandId: `plan:${plan.id}:${purpose}:${triggerId}`,
    });
  }

  protected async getRuntimeSnapshot(userId: string, conversationId: string): Promise<RuntimeSnapshot> {
    const [plans, latestPlan] = await Promise.all([
      this.planService?.listPlanSnapshots
        ? this.planService.listPlanSnapshots(userId, conversationId)
        : Promise.resolve([]),
      this.planService?.getLatestPlanSnapshot
        ? this.planService.getLatestPlanSnapshot(userId, conversationId)
        : Promise.resolve(null),
    ]);
    const activePlan = latestPlan ?? plans.at(-1) ?? null;
    const pendingInputs = await this.db
      .select()
      .from(aiConversationInputs)
      .where(and(eq(aiConversationInputs.conversationId, conversationId), eq(aiConversationInputs.status, 'pending')))
      .orderBy(asc(aiConversationInputs.createdAt));
    const activeRun = await this.getActiveRun(conversationId);
    if (!activeRun) {
      const [lastRun] = await this.db
        .select({ status: aiRuns.status })
        .from(aiRuns)
        .where(eq(aiRuns.conversationId, conversationId))
        .orderBy(desc(aiRuns.createdAt))
        .limit(1);
      return {
        activeRun: null,
        activePlan,
        plans,
        canContinue: lastRun?.status === 'failed' || lastRun?.status === 'stopped',
        assistantDraftContent: null,
        assistantDraftVersion: null,
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        pendingCredentialChallenge: null,
        pendingSetupInteraction: null,
        toolCalls: await this.listConversationToolCalls(conversationId),
        toolRounds: [],
        pendingInputs,
      };
    }

    const [activeToolCalls, questions, challenges, setupInteractions, toolCalls, toolRounds] = await Promise.all([
      this.db.select().from(aiRunToolCalls).where(eq(aiRunToolCalls.runId, activeRun.id)),
      this.db
        .select()
        .from(aiRunQuestions)
        .where(eq(aiRunQuestions.runId, activeRun.id))
        .orderBy(asc(aiRunQuestions.createdAt)),
      this.db
        .select()
        .from(aiRunCredentialChallenges)
        .where(and(eq(aiRunCredentialChallenges.runId, activeRun.id), eq(aiRunCredentialChallenges.status, 'pending')))
        .orderBy(asc(aiRunCredentialChallenges.createdAt)),
      this.db
        .select()
        .from(aiRunSetupInteractions)
        .where(and(eq(aiRunSetupInteractions.runId, activeRun.id), eq(aiRunSetupInteractions.status, 'pending')))
        .orderBy(asc(aiRunSetupInteractions.createdAt)),
      this.listConversationToolCalls(conversationId),
      this.db
        .select()
        .from(aiRunToolRounds)
        .where(eq(aiRunToolRounds.runId, activeRun.id))
        .orderBy(asc(aiRunToolRounds.sequence)),
    ]);
    const pendingQuestions = questions.filter((question) => question.status === 'pending');
    const liveDraft = this.executor.getAssistantDraft(activeRun.id);
    const assistantDraftContent = liveDraft?.content ?? activeRun.assistantDraftContent ?? null;

    return {
      activeRun,
      activePlan,
      plans,
      canContinue: false,
      assistantDraftContent,
      assistantDraftVersion: liveDraft?.version ?? (assistantDraftContent ? 0 : null),
      pendingApprovals: activeToolCalls.filter((toolCall) => toolCall.status === 'pending_approval'),
      pendingQuestion: pendingQuestions[0] ?? null,
      pendingQuestions,
      pendingCredentialChallenge: challenges[0] ?? null,
      pendingSetupInteraction: setupInteractions[0] ?? null,
      toolCalls,
      toolRounds,
      pendingInputs,
    };
  }

  async getConversationSnapshot(userId: string, conversationId: string): Promise<AIConversationRuntimeSnapshot | null> {
    const conversation = await getOwnedConversation(this.db, userId, conversationId);
    if (!conversation) return null;

    const [messages, runtime] = await Promise.all([
      this.db
        .select({
          id: aiConversationMessages.id,
          sequence: aiConversationMessages.sequence,
          uiMessage: aiConversationMessages.uiMessage,
          createdAt: aiConversationMessages.createdAt,
        })
        .from(aiConversationMessages)
        .where(eq(aiConversationMessages.conversationId, conversationId))
        .orderBy(asc(aiConversationMessages.sequence)),
      this.getRuntimeSnapshot(userId, conversationId),
    ]);

    const allSnapshotMessages = messages.map((message) =>
      toSnapshotMessage(message.id, message.sequence, message.uiMessage, message.createdAt)
    );
    const snapshotMessages = allSnapshotMessages.filter((message) => !isHiddenSystemMessage(message));
    const uiMessages = allSnapshotMessages;
    const loadedMessageRows = messages.map((message) => ({
      role: readMessageRole(message.uiMessage),
      uiMessage: message.uiMessage,
      createdAt: message.createdAt,
    }));

    return {
      revision: conversation.revision,
      resourceReferences: collectResourceReferences(runtime.toolCalls),
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        folderId: conversation.folderId,
        lastUserMessageAt: getLastUserMessageAt(loadedMessageRows),
        messageCount: countVisibleMessages(uiMessages),
        ...deriveConversationStatus(uiMessages),
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort,
        lastContext: conversation.lastContext,
        discoveredToolsets: conversation.discoveredToolsets,
        checkpoint: toClientCheckpoint(conversation.checkpoint),
      },
      messages: withAssistantDraftMessage(snapshotMessages, runtime.activeRun, runtime.assistantDraftContent),
      runtime,
    };
  }

  protected async findRunByCommand(
    userId: string,
    conversationId: string,
    clientCommandId: string
  ): Promise<AIRun | null> {
    return findRunByCommand(this.db, userId, conversationId, clientCommandId);
  }

  protected async findRunByUserCommand(userId: string, clientCommandId: string): Promise<AIRun | null> {
    return findRunByUserCommand(this.db, userId, clientCommandId);
  }

  protected async getToolCall(db: DrizzleExecutor, toolCallId: string): Promise<AIRunToolCall | null> {
    const rows = await db.select().from(aiRunToolCalls).where(toolCallIdentityWhere(toolCallId)).limit(1);
    return rows[0] ?? null;
  }

  protected async getQuestion(
    db: DrizzleExecutor,
    questionId: string,
    runId: string,
    conversationId: string
  ): Promise<AIRunQuestion | null> {
    const rows = await db
      .select()
      .from(aiRunQuestions)
      .where(
        and(
          questionIdentityWhere(questionId),
          eq(aiRunQuestions.runId, runId),
          eq(aiRunQuestions.conversationId, conversationId)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  protected async listPendingQuestions(db: DrizzleExecutor, runId: string): Promise<AIRunQuestion[]> {
    return db
      .select()
      .from(aiRunQuestions)
      .where(and(eq(aiRunQuestions.runId, runId), eq(aiRunQuestions.status, 'pending')))
      .orderBy(asc(aiRunQuestions.createdAt));
  }

  protected async listConversationToolCalls(conversationId: string): Promise<AIRunToolCall[]> {
    const toolCalls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
    return toolCalls.filter((toolCall) => toolCall.toolName !== 'send_comment');
  }

  protected publishConversationChanged(userId: string, conversationId: string, invalidatedStores?: string[]): void {
    const event = {
      userId,
      conversationId,
      ...(invalidatedStores?.length ? { invalidatedStores } : {}),
    } satisfies AIConversationChangedEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  protected publishAssistantDelta(
    userId: string,
    conversationId: string,
    runId: string,
    content: string,
    version: number
  ): void {
    const event = {
      type: 'assistant.delta',
      userId,
      conversationId,
      runId,
      content,
      version,
    } satisfies AIAssistantDeltaEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  protected publishAssistantCommentDelta(
    userId: string,
    conversationId: string,
    runId: string,
    content: string,
    version: number
  ): void {
    const event = {
      type: 'assistant.comment_delta',
      userId,
      conversationId,
      runId,
      content,
      version,
    } satisfies AIAssistantCommentDeltaEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  protected publishAssistantCommentDone(userId: string, conversationId: string, runId: string): void {
    const event = {
      type: 'assistant.comment_done',
      userId,
      conversationId,
      runId,
    } satisfies AIAssistantCommentDoneEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  protected publishCredentialChallenge(
    userId: string,
    conversationId: string,
    runId: string,
    challenge: AICredentialChallenge
  ): void {
    const event = {
      type: 'credential.required',
      userId,
      conversationId,
      runId,
      challenge,
    } satisfies AICredentialRequiredEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  protected publishClientAction(
    userId: string,
    conversationId: string,
    runId: string,
    action: Record<string, unknown>
  ): void {
    const event = {
      type: 'client.action',
      userId,
      conversationId,
      runId,
      action,
    } satisfies AIClientActionEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }
}
