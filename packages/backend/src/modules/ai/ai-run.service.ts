import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleExecutor } from '@/db/client.js';
import {
  type AIConversationInput,
  type AICredentialChallenge,
  type AIRun,
  type AIRunPurpose,
  type AIRunQuestion,
  type AIRunStatus,
  type AIRunToolCall,
  type AISetupInteraction,
  aiConversationInputs,
  aiConversationMessages,
  aiConversations,
  aiPlans,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRunSetupInteractions,
  aiRuns,
  aiRunToolCalls,
  aiRunToolRounds,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { AIPlanRuntimeSnapshot } from './ai.types.js';
import { AIRunServiceRuntime } from './ai-run.service.runtime.js';
import {
  ACTIVE_RUN_STATUSES,
  assertConversationCanAcceptUserTurn,
  assertConversationCanCompact,
  assertOwnedConversation,
  type CreateAIRunInput,
  createConversation,
  findRunByCommand,
  getActiveRunForUpdate,
  getOwnedConversation,
  nextMessageSequence,
  normalizeConversationTitle,
  normalizeOptionalString,
  type QueueConversationInputResult,
  questionIdentityWhere,
  type RecordToolCallInput,
  resolveUniqueTitle,
  type StartContextCompactionInput,
  type StartContinuationRunInput,
  type StartUserRunInput,
  type StartUserRunResult,
  toConversationMessage,
  toolCallIdentityWhere,
} from './ai-run.shared.js';
import { AI_CONTINUATION_COMMAND_PREFIX } from './ai-run-runtime.helpers.js';

export * from './ai-run.shared.js';

export class AIRunService extends AIRunServiceRuntime {
  async attachRunToPlan(input: {
    userId: string;
    conversationId: string;
    runId: string;
    plan: AIPlanRuntimeSnapshot;
    purpose: AIRunPurpose;
  }): Promise<AIRun> {
    const [run] = await this.db
      .update(aiRuns)
      .set({
        planId: input.plan.id,
        planRevisionId: input.plan.revisionId,
        purpose: input.purpose,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiRuns.id, input.runId),
          eq(aiRuns.userId, input.userId),
          eq(aiRuns.conversationId, input.conversationId),
          eq(aiRuns.status, 'queued')
        )
      )
      .returning();
    if (!run) throw new AppError(409, 'AI_PLAN_RUN_NOT_ATTACHABLE', 'The AI run is no longer available for Plan Mode');
    this.publishConversationChanged(input.userId, input.conversationId);
    return run;
  }

  async startPlanRun(input: {
    user: User;
    plan: AIPlanRuntimeSnapshot;
    purpose: Exclude<AIRunPurpose, 'direct'>;
    clientCommandId: string;
    instruction?: string;
  }): Promise<{ run: AIRun; duplicate: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.user.id, input.plan.conversationId);
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      const existing = await findRunByCommand(tx, input.user.id, conversation.id, input.clientCommandId);
      if (existing) return { run: existing, duplicate: true };
      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      if (activeRun) throw new AppError(409, 'AI_RUN_ACTIVE', 'Conversation already has an active AI run');

      let activeMessageId: string | null = null;
      const pendingInputs = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.conversationId, conversation.id),
            eq(aiConversationInputs.userId, input.user.id),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .orderBy(asc(aiConversationInputs.createdAt));
      const userMessages = [
        ...pendingInputs.map((item) => ({
          content: item.content,
          attachments: item.attachments,
          steer: true,
        })),
        ...(input.instruction?.trim() ? [{ content: input.instruction.trim(), attachments: [], steer: true }] : []),
      ];
      if (userMessages.length > 0) {
        let sequence = await nextMessageSequence(tx, conversation.id);
        const inserted = await tx
          .insert(aiConversationMessages)
          .values(
            userMessages.map((message) =>
              toConversationMessage(
                conversation.id,
                {
                  role: 'user',
                  content: message.content,
                  attachments: message.attachments,
                  steer: message.steer,
                },
                sequence++
              )
            )
          )
          .returning({ id: aiConversationMessages.id });
        activeMessageId = inserted.at(-1)?.id ?? null;
        if (pendingInputs.length > 0) {
          const now = new Date();
          await tx
            .update(aiConversationInputs)
            .set({ status: 'consumed', consumedAt: now, updatedAt: now })
            .where(
              inArray(
                aiConversationInputs.id,
                pendingInputs.map((item) => item.id)
              )
            );
        }
      }
      if (!activeMessageId) {
        const [lastUserMessage] = await tx
          .select({ id: aiConversationMessages.id })
          .from(aiConversationMessages)
          .where(
            and(eq(aiConversationMessages.conversationId, conversation.id), eq(aiConversationMessages.role, 'user'))
          )
          .orderBy(desc(aiConversationMessages.sequence))
          .limit(1);
        activeMessageId = lastUserMessage?.id ?? null;
      }
      if (!activeMessageId) {
        throw new AppError(409, 'AI_PLAN_MESSAGE_REQUIRED', 'A Plan Mode run requires conversation context');
      }

      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId: conversation.id,
          userId: input.user.id,
          planId: input.plan.id,
          planRevisionId: input.plan.revisionId,
          purpose: input.purpose,
          clientCommandId: input.clientCommandId,
          activeMessageId,
          model: input.plan.model ?? conversation.model,
          reasoningEffort: input.plan.reasoningEffort ?? conversation.reasoningEffort,
          status: 'queued',
          updatedAt: new Date(),
        })
        .returning();
      return { run, duplicate: false };
    });
    this.publishConversationChanged(input.user.id, input.plan.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(input.user.id, input.plan.conversationId);
    if (!result.duplicate || result.run.status === 'queued') this.startRunExecution(input.user, result.run.id);
    return result;
  }

  async startUserRun(input: StartUserRunInput): Promise<StartUserRunResult> {
    const title = normalizeConversationTitle(input.title);
    const existingByCommand = input.conversationId
      ? await this.findRunByCommand(input.userId, input.conversationId, input.clientCommandId)
      : await this.findRunByUserCommand(input.userId, input.clientCommandId);
    if (existingByCommand) {
      return {
        conversationId: existingByCommand.conversationId,
        userMessageId: existingByCommand.activeMessageId,
        run: existingByCommand,
        duplicate: true,
      };
    }

    const result = await this.db.transaction(async (tx) => {
      const conversation = input.conversationId
        ? await getOwnedConversation(tx, input.userId, input.conversationId)
        : await createConversation(tx, {
            userId: input.userId,
            title: await resolveUniqueTitle(tx, input.userId, title),
            lastContext: input.lastContext ?? null,
            model: normalizeOptionalString(input.model),
            reasoningEffort: normalizeOptionalString(input.reasoningEffort),
          });

      if (!conversation) {
        throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      }

      const existingInTransaction = await findRunByCommand(tx, input.userId, conversation.id, input.clientCommandId);
      if (existingInTransaction) {
        return {
          conversationId: existingInTransaction.conversationId,
          userMessageId: existingInTransaction.activeMessageId,
          run: existingInTransaction,
          duplicate: true,
        };
      }

      if (input.conversationId) {
        await assertConversationCanAcceptUserTurn(tx, conversation.id);
      }

      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      if (activeRun) {
        throw new AppError(409, 'AI_RUN_ACTIVE', 'Conversation already has an active AI run');
      }

      const now = new Date();
      const hasPinnedProvider = conversation.model !== null;
      const model = conversation.model ?? normalizeOptionalString(input.model);
      const reasoningEffort = hasPinnedProvider
        ? conversation.reasoningEffort
        : normalizeOptionalString(input.reasoningEffort);
      const sequence = await nextMessageSequence(tx, conversation.id);
      const [message] = await tx
        .insert(aiConversationMessages)
        .values(
          toConversationMessage(
            conversation.id,
            { ...input.userMessage, clientCommandId: input.clientCommandId },
            sequence
          )
        )
        .returning({ id: aiConversationMessages.id });

      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId: conversation.id,
          userId: input.userId,
          clientCommandId: input.clientCommandId,
          activeMessageId: message.id,
          model,
          reasoningEffort,
          status: 'queued',
          updatedAt: now,
        })
        .returning();

      await tx
        .update(aiConversations)
        .set({
          model,
          reasoningEffort,
          lastContext: input.lastContext ?? conversation.lastContext,
          updatedAt: now,
        })
        .where(eq(aiConversations.id, conversation.id));

      return {
        conversationId: conversation.id,
        userMessageId: message.id,
        run,
        duplicate: false,
      };
    });

    this.publishConversationChanged(input.userId, result.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(input.userId, result.conversationId);
    return result;
  }

  async startContextCompactionRun(input: StartContextCompactionInput): Promise<StartUserRunResult> {
    const existingByCommand = await this.findRunByCommand(input.userId, input.conversationId, input.clientCommandId);
    if (existingByCommand) {
      return {
        conversationId: existingByCommand.conversationId,
        userMessageId: existingByCommand.activeMessageId,
        run: existingByCommand,
        duplicate: true,
      };
    }

    const result = await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.userId, input.conversationId);
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

      const existingInTransaction = await findRunByCommand(tx, input.userId, conversation.id, input.clientCommandId);
      if (existingInTransaction) {
        return {
          conversationId: existingInTransaction.conversationId,
          userMessageId: existingInTransaction.activeMessageId,
          run: existingInTransaction,
          duplicate: true,
        };
      }

      await assertConversationCanCompact(tx, conversation.id);

      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      if (activeRun) {
        throw new AppError(409, 'AI_RUN_ACTIVE', 'Conversation already has an active AI run');
      }

      const now = new Date();
      const hasPinnedProvider = conversation.model !== null;
      const model = conversation.model ?? normalizeOptionalString(input.model);
      const reasoningEffort = hasPinnedProvider
        ? conversation.reasoningEffort
        : normalizeOptionalString(input.reasoningEffort);
      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId: conversation.id,
          userId: input.userId,
          clientCommandId: input.clientCommandId,
          activeMessageId: null,
          model,
          reasoningEffort,
          status: 'queued',
          updatedAt: now,
        })
        .returning();

      await tx
        .update(aiConversations)
        .set({
          model,
          reasoningEffort,
          lastContext: input.lastContext ?? conversation.lastContext,
          updatedAt: now,
        })
        .where(eq(aiConversations.id, conversation.id));

      return {
        conversationId: conversation.id,
        userMessageId: null,
        run,
        duplicate: false,
      };
    });

    this.publishConversationChanged(input.userId, result.conversationId);
    return result;
  }

  async startContinuationRun(input: StartContinuationRunInput): Promise<StartUserRunResult> {
    const clientCommandId = `${AI_CONTINUATION_COMMAND_PREFIX}${input.clientCommandId}`;
    const existingByCommand = await this.findRunByCommand(input.userId, input.conversationId, clientCommandId);
    if (existingByCommand) {
      return {
        conversationId: existingByCommand.conversationId,
        userMessageId: existingByCommand.activeMessageId,
        run: existingByCommand,
        duplicate: true,
      };
    }

    const result = await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.userId, input.conversationId);
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      await assertConversationCanAcceptUserTurn(tx, conversation.id);

      const existingInTransaction = await findRunByCommand(tx, input.userId, conversation.id, clientCommandId);
      if (existingInTransaction) {
        return {
          conversationId: existingInTransaction.conversationId,
          userMessageId: existingInTransaction.activeMessageId,
          run: existingInTransaction,
          duplicate: true,
        };
      }

      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      if (activeRun) throw new AppError(409, 'AI_RUN_ACTIVE', 'Conversation already has an active AI run');

      const [lastRun] = await tx
        .select({ status: aiRuns.status })
        .from(aiRuns)
        .where(eq(aiRuns.conversationId, conversation.id))
        .orderBy(desc(aiRuns.createdAt))
        .limit(1);
      if (lastRun?.status !== 'failed' && lastRun?.status !== 'stopped') {
        throw new AppError(409, 'AI_CONTINUATION_UNAVAILABLE', 'There is no interrupted assistant turn to continue');
      }

      const [lastUserMessage] = await tx
        .select({ id: aiConversationMessages.id })
        .from(aiConversationMessages)
        .where(and(eq(aiConversationMessages.conversationId, conversation.id), eq(aiConversationMessages.role, 'user')))
        .orderBy(desc(aiConversationMessages.sequence))
        .limit(1);
      if (!lastUserMessage) {
        throw new AppError(409, 'AI_CONTINUATION_UNAVAILABLE', 'There is no interrupted assistant turn to continue');
      }

      const now = new Date();
      const hasPinnedProvider = conversation.model !== null;
      const model = conversation.model ?? normalizeOptionalString(input.model);
      const reasoningEffort = hasPinnedProvider
        ? conversation.reasoningEffort
        : normalizeOptionalString(input.reasoningEffort);
      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId: conversation.id,
          userId: input.userId,
          clientCommandId,
          activeMessageId: lastUserMessage.id,
          model,
          reasoningEffort,
          status: 'queued',
          updatedAt: now,
        })
        .returning();

      await tx
        .update(aiConversations)
        .set({
          model,
          reasoningEffort,
          lastContext: input.lastContext ?? conversation.lastContext,
          updatedAt: now,
        })
        .where(eq(aiConversations.id, conversation.id));

      return {
        conversationId: conversation.id,
        userMessageId: lastUserMessage.id,
        run,
        duplicate: false,
      };
    });

    this.publishConversationChanged(input.userId, result.conversationId);
    return result;
  }

  async queueConversationInput(input: {
    conversationId: string;
    userId: string;
    inputId: string;
    clientCommandId: string;
    content: string;
    attachments?: AIConversationInput['attachments'];
    context?: Record<string, unknown> | null;
  }): Promise<QueueConversationInputResult> {
    const existing = await this.db
      .select()
      .from(aiConversationInputs)
      .where(
        and(
          eq(aiConversationInputs.userId, input.userId),
          eq(aiConversationInputs.clientCommandId, input.clientCommandId)
        )
      )
      .limit(1);
    if (existing[0]) {
      return { input: existing[0], duplicate: true, executionStarted: false };
    }

    const result = await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.userId, input.conversationId);
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      await assertConversationCanAcceptUserTurn(tx, conversation.id);
      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      const [queued] = await tx
        .insert(aiConversationInputs)
        .values({
          id: input.inputId,
          conversationId: conversation.id,
          targetRunId: activeRun?.id ?? null,
          userId: input.userId,
          clientCommandId: input.clientCommandId,
          mode: 'queued',
          status: 'pending',
          content: input.content,
          attachments: input.attachments ?? [],
          context: input.context ?? null,
        })
        .onConflictDoNothing({ target: [aiConversationInputs.userId, aiConversationInputs.clientCommandId] })
        .returning();
      if (queued) return { input: queued, duplicate: false, shouldStart: !activeRun };
      const [duplicate] = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.userId, input.userId),
            eq(aiConversationInputs.clientCommandId, input.clientCommandId)
          )
        )
        .limit(1);
      if (!duplicate) throw new AppError(409, 'AI_INPUT_CONFLICT', 'Queued message could not be created');
      return { input: duplicate, duplicate: true, shouldStart: false };
    });

    this.publishConversationChanged(input.userId, input.conversationId);
    return { input: result.input, duplicate: result.duplicate, executionStarted: result.shouldStart };
  }

  async steerConversationInput(input: {
    conversationId: string;
    inputId: string;
    userId: string;
  }): Promise<{ input: AIConversationInput; executionStarted: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.userId, input.conversationId);
      if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      const [updated] = await tx
        .update(aiConversationInputs)
        .set({
          mode: activeRun ? 'steer' : 'queued',
          targetRunId: activeRun?.id ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiConversationInputs.id, input.inputId),
            eq(aiConversationInputs.conversationId, input.conversationId),
            eq(aiConversationInputs.userId, input.userId),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .returning();
      if (!updated) throw new AppError(409, 'AI_INPUT_NOT_PENDING', 'Queued message is no longer pending');
      return { input: updated, shouldStart: !activeRun };
    });
    this.publishConversationChanged(input.userId, input.conversationId);
    return { input: result.input, executionStarted: result.shouldStart };
  }

  async cancelConversationInput(input: {
    conversationId: string;
    inputId: string;
    userId: string;
  }): Promise<AIConversationInput> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const [cancelled] = await this.db
      .update(aiConversationInputs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(aiConversationInputs.id, input.inputId),
          eq(aiConversationInputs.conversationId, input.conversationId),
          eq(aiConversationInputs.userId, input.userId),
          eq(aiConversationInputs.status, 'pending')
        )
      )
      .returning();
    if (!cancelled) throw new AppError(409, 'AI_INPUT_NOT_PENDING', 'Queued message is no longer pending');
    this.publishConversationChanged(input.userId, input.conversationId);
    return cancelled;
  }

  async updateConversationProvider(input: {
    userId: string;
    conversationId: string;
    model: string;
    reasoningEffort: string | null;
    modelDisplayName: string;
    previousModelDisplayName?: string | null;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const conversation = await getOwnedConversation(tx, input.userId, input.conversationId);
      if (!conversation) {
        throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
      }

      const activeRun = await getActiveRunForUpdate(tx, conversation.id);
      if (activeRun) {
        throw new AppError(409, 'AI_RUN_ACTIVE', 'The model cannot be changed while the assistant is responding');
      }

      const model = input.model.trim();
      const reasoningEffort = normalizeOptionalString(input.reasoningEffort);
      if (!model) {
        throw new AppError(400, 'AI_MODEL_REQUIRED', 'A model is required');
      }
      if (conversation.model === model && conversation.reasoningEffort === reasoningEffort) return;

      const now = new Date();
      if (conversation.model && conversation.model !== model) {
        const sequence = await nextMessageSequence(tx, conversation.id);
        await tx.insert(aiConversationMessages).values(
          toConversationMessage(
            conversation.id,
            {
              role: 'assistant',
              content: '',
              localOnly: true,
              modelChange: {
                fromModel: conversation.model,
                toModel: model,
                fromDisplayName: input.previousModelDisplayName?.trim() || conversation.model,
                toDisplayName: input.modelDisplayName.trim() || model,
              },
            },
            sequence
          )
        );
      }

      await tx
        .update(aiConversations)
        .set({ model, reasoningEffort, updatedAt: now })
        .where(and(eq(aiConversations.id, conversation.id), eq(aiConversations.userId, input.userId)));

      // A published or paused plan belongs to the conversation, not to the
      // browser that created it. Keep its execution provider aligned with an
      // explicit conversation-level model change so another device cannot
      // silently resume the plan on the previous model.
      await tx
        .update(aiPlans)
        .set({ model, reasoningEffort, updatedAt: now })
        .where(
          and(
            eq(aiPlans.conversationId, conversation.id),
            eq(aiPlans.userId, input.userId),
            inArray(aiPlans.status, [
              'drafting',
              'validating',
              'awaiting_decision',
              'pause_requested',
              'paused',
              'executing',
              'verifying',
            ])
          )
        );
    });

    this.publishConversationChanged(input.userId, input.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(input.userId, input.conversationId);
  }

  async createRun(input: CreateAIRunInput): Promise<{ run: AIRun; duplicate: boolean }> {
    const existingByCommand = await this.findRunByCommand(input.userId, input.conversationId, input.clientCommandId);
    if (existingByCommand) return { run: existingByCommand, duplicate: true };

    const [run] = await this.db
      .insert(aiRuns)
      .values({
        conversationId: input.conversationId,
        userId: input.userId,
        clientCommandId: input.clientCommandId,
        activeMessageId: input.activeMessageId ?? null,
        model: input.model?.trim() || null,
        reasoningEffort: input.reasoningEffort?.trim() || null,
      })
      .returning();

    return { run, duplicate: false };
  }

  async getActiveRun(conversationId: string): Promise<AIRun | null> {
    const rows = await this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, ACTIVE_RUN_STATUSES)))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateRunStatus(runId: string, status: AIRunStatus, error?: string | null): Promise<AIRun> {
    const now = new Date();
    const terminal =
      status === 'completed'
        ? { completedAt: now, stoppedAt: null }
        : status === 'stopped'
          ? { completedAt: null, stoppedAt: now }
          : { completedAt: null, stoppedAt: null };
    const [run] = await this.db
      .update(aiRuns)
      .set({
        status,
        error: error ?? null,
        updatedAt: now,
        startedAt: status === 'running' ? now : undefined,
        ...terminal,
      })
      .where(eq(aiRuns.id, runId))
      .returning();
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    return run;
  }

  async recordToolCall(input: RecordToolCallInput): Promise<AIRunToolCall> {
    const [toolCall] = await this.db
      .insert(aiRunToolCalls)
      .values({
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId ?? null,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        classification: input.classification,
        approvalPolicy: input.approvalPolicy,
        requiredScopes: input.requiredScopes ?? [],
        status: input.status ?? 'created',
      })
      .onConflictDoUpdate({
        target: [aiRunToolCalls.runId, aiRunToolCalls.toolCallId],
        set: {
          assistantMessageId: input.assistantMessageId ?? null,
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          classification: input.classification,
          approvalPolicy: input.approvalPolicy,
          requiredScopes: input.requiredScopes ?? [],
          updatedAt: new Date(),
        },
      })
      .returning();
    return toolCall;
  }

  async decideToolCall(input: {
    conversationId: string;
    runId: string;
    toolCallId: string;
    userId: string;
    clientCommandId: string;
    decision: 'approved' | 'rejected';
  }): Promise<{
    toolCall: AIRunToolCall;
    duplicate: boolean;
    continuationReady: boolean;
  }> {
    const result = await this.db.transaction(async (tx) => {
      await assertOwnedConversation(tx, input.userId, input.conversationId);
      const nextStatus = input.decision === 'approved' ? 'approved' : 'rejected';
      const now = new Date();
      const [updated] = await tx
        .update(aiRunToolCalls)
        .set({
          status: nextStatus,
          decision: input.decision,
          decisionUserId: input.userId,
          decisionClientCommandId: input.clientCommandId,
          decisionAt: now,
          updatedAt: now,
        })
        .where(
          and(
            toolCallIdentityWhere(input.toolCallId),
            eq(aiRunToolCalls.runId, input.runId),
            eq(aiRunToolCalls.conversationId, input.conversationId),
            eq(aiRunToolCalls.status, 'pending_approval')
          )
        )
        .returning();

      if (updated) {
        return {
          toolCall: updated,
          duplicate: false,
          continuationReady: await this.markToolRoundReadyIfUngated(tx, updated),
        };
      }

      const existing = await this.getToolCall(tx, input.toolCallId);
      if (!existing) throw new AppError(404, 'AI_TOOL_CALL_NOT_FOUND', 'AI tool call not found');
      if (existing.runId !== input.runId || existing.conversationId !== input.conversationId) {
        throw new AppError(404, 'AI_TOOL_CALL_NOT_FOUND', 'AI tool call not found');
      }
      if (existing.decision === input.decision && (existing.status === 'approved' || existing.status === 'rejected')) {
        return {
          toolCall: existing,
          duplicate: true,
          continuationReady: await this.markToolRoundReadyIfUngated(tx, existing),
        };
      }
      throw new AppError(409, 'AI_TOOL_CALL_DECISION_CONFLICT', 'Tool call is no longer pending approval');
    });

    if (!result.duplicate) this.publishConversationChanged(input.userId, input.conversationId);
    return result;
  }

  protected async markToolRoundReadyIfUngated(db: DrizzleExecutor, toolCall: AIRunToolCall): Promise<boolean> {
    if (!toolCall.roundId) return true;
    return this.markRoundReadyIfUngated(db, toolCall.roundId);
  }

  protected async markRoundReadyIfUngated(db: DrizzleExecutor, roundId: string): Promise<boolean> {
    const [calls, pendingQuestions, pendingCredentials, pendingSetups] = await Promise.all([
      db.select({ status: aiRunToolCalls.status }).from(aiRunToolCalls).where(eq(aiRunToolCalls.roundId, roundId)),
      db
        .select({ id: aiRunQuestions.id })
        .from(aiRunQuestions)
        .where(and(eq(aiRunQuestions.roundId, roundId), eq(aiRunQuestions.status, 'pending'))),
      db
        .select({ id: aiRunCredentialChallenges.id })
        .from(aiRunCredentialChallenges)
        .where(and(eq(aiRunCredentialChallenges.roundId, roundId), eq(aiRunCredentialChallenges.status, 'pending'))),
      db
        .select({ id: aiRunSetupInteractions.id })
        .from(aiRunSetupInteractions)
        .where(and(eq(aiRunSetupInteractions.roundId, roundId), eq(aiRunSetupInteractions.status, 'pending'))),
    ]);
    const hasPendingApprovals = calls.some((call) => call.status === 'pending_approval');
    if (
      pendingQuestions.length > 0 ||
      hasPendingApprovals ||
      pendingCredentials.length > 0 ||
      pendingSetups.length > 0
    ) {
      await db
        .update(aiRunToolRounds)
        .set({
          status:
            pendingQuestions.length > 0
              ? 'waiting_questions'
              : hasPendingApprovals
                ? 'waiting_approvals'
                : pendingSetups.length > 0
                  ? 'waiting_setup'
                  : 'executing',
          updatedAt: new Date(),
        })
        .where(eq(aiRunToolRounds.id, roundId));
      return false;
    }
    await db
      .update(aiRunToolRounds)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(aiRunToolRounds.id, roundId));
    return true;
  }

  async recordQuestion(input: {
    runId: string;
    conversationId: string;
    question: string;
    toolCallId?: string;
  }): Promise<AIRunQuestion> {
    const [question] = await this.db
      .insert(aiRunQuestions)
      .values({
        runId: input.runId,
        conversationId: input.conversationId,
        toolCallId: input.toolCallId ?? input.runId,
        question: input.question,
      })
      .returning();
    return question;
  }

  async answerQuestion(input: {
    conversationId: string;
    runId: string;
    questionId: string;
    userId: string;
    clientCommandId: string;
    answer: string;
  }): Promise<{
    question: AIRunQuestion;
    duplicate: boolean;
    remainingPendingQuestions: AIRunQuestion[];
    continuationReady: boolean;
  }> {
    const result = await this.db.transaction(async (tx) => {
      await assertOwnedConversation(tx, input.userId, input.conversationId);
      const now = new Date();
      const [updated] = await tx
        .update(aiRunQuestions)
        .set({
          status: 'answered',
          answer: input.answer,
          answerUserId: input.userId,
          answerClientCommandId: input.clientCommandId,
          answeredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            questionIdentityWhere(input.questionId),
            eq(aiRunQuestions.runId, input.runId),
            eq(aiRunQuestions.conversationId, input.conversationId),
            eq(aiRunQuestions.status, 'pending')
          )
        )
        .returning();

      if (updated) {
        const remainingPendingQuestions = await this.listPendingQuestions(tx, input.runId);
        return {
          question: updated,
          duplicate: false,
          remainingPendingQuestions,
          continuationReady:
            remainingPendingQuestions.length === 0 ? await this.markQuestionRoundReadyIfUngated(tx, updated) : false,
        };
      }

      const existing = await this.getQuestion(tx, input.questionId, input.runId, input.conversationId);
      if (!existing) throw new AppError(404, 'AI_QUESTION_NOT_FOUND', 'AI question not found');
      if (existing.runId !== input.runId || existing.conversationId !== input.conversationId) {
        throw new AppError(404, 'AI_QUESTION_NOT_FOUND', 'AI question not found');
      }
      if (existing.status === 'answered' && existing.answer === input.answer) {
        const remainingPendingQuestions = await this.listPendingQuestions(tx, input.runId);
        return {
          question: existing,
          duplicate: true,
          remainingPendingQuestions,
          continuationReady:
            remainingPendingQuestions.length === 0 ? await this.markQuestionRoundReadyIfUngated(tx, existing) : false,
        };
      }
      throw new AppError(409, 'AI_QUESTION_ANSWER_CONFLICT', 'Question is no longer pending');
    });

    if (!result.duplicate) this.publishConversationChanged(input.userId, input.conversationId);
    return result;
  }

  protected async markQuestionRoundReadyIfUngated(db: DrizzleExecutor, question: AIRunQuestion): Promise<boolean> {
    if (!question.roundId) return true;
    return this.markRoundReadyIfUngated(db, question.roundId);
  }

  startApprovalContinuation(
    user: User,
    input: {
      conversationId: string;
      runId: string;
      toolCall: AIRunToolCall;
      approved: boolean;
    }
  ): void {
    this.executor.startApprovalContinuation(user, input);
  }

  startToolRoundContinuation(user: User, input: { conversationId: string; runId: string; roundId: string }): void {
    this.executor.startToolRoundContinuation(user, input);
  }

  startQuestionContinuation(
    user: User,
    input: {
      conversationId: string;
      runId: string;
      question: AIRunQuestion;
    }
  ): void {
    this.executor.startQuestionContinuation(user, input);
  }

  async resolveCredentialChallenge(input: {
    conversationId: string;
    runId: string;
    challengeId: string;
    userId: string;
    clientCommandId: string;
    decision: 'authorized' | 'rejected';
  }): Promise<{
    challenge: AICredentialChallenge;
    additionalChallenges: AICredentialChallenge[];
    duplicate: boolean;
  }> {
    const result = await this.db.transaction(async (tx) => {
      await assertOwnedConversation(tx, input.userId, input.conversationId);
      const now = new Date();
      const [updated] = await tx
        .update(aiRunCredentialChallenges)
        .set({
          status: input.decision,
          decisionClientCommandId: input.clientCommandId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(aiRunCredentialChallenges.id, input.challengeId),
            eq(aiRunCredentialChallenges.runId, input.runId),
            eq(aiRunCredentialChallenges.conversationId, input.conversationId),
            eq(aiRunCredentialChallenges.userId, input.userId),
            eq(aiRunCredentialChallenges.status, 'pending')
          )
        )
        .returning();
      if (updated) {
        const additionalChallenges =
          input.decision === 'authorized'
            ? await tx
                .update(aiRunCredentialChallenges)
                .set({
                  status: 'authorized',
                  decisionClientCommandId: input.clientCommandId,
                  resolvedAt: now,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(aiRunCredentialChallenges.userId, input.userId),
                    eq(aiRunCredentialChallenges.connectorId, updated.connectorId),
                    eq(aiRunCredentialChallenges.status, 'pending')
                  )
                )
                .returning()
            : [];
        for (const challenge of [updated, ...additionalChallenges]) {
          if (challenge.roundId) await this.markRoundReadyIfUngated(tx, challenge.roundId);
        }
        return { challenge: updated, additionalChallenges, duplicate: false };
      }

      const [existing] = await tx
        .select()
        .from(aiRunCredentialChallenges)
        .where(
          and(
            eq(aiRunCredentialChallenges.id, input.challengeId),
            eq(aiRunCredentialChallenges.runId, input.runId),
            eq(aiRunCredentialChallenges.conversationId, input.conversationId),
            eq(aiRunCredentialChallenges.userId, input.userId)
          )
        )
        .limit(1);
      if (!existing) throw new AppError(404, 'AI_CREDENTIAL_CHALLENGE_NOT_FOUND', 'Credential challenge not found');
      if (existing.status === input.decision) {
        if (existing.roundId) await this.markRoundReadyIfUngated(tx, existing.roundId);
        return { challenge: existing, additionalChallenges: [], duplicate: true };
      }
      throw new AppError(409, 'AI_CREDENTIAL_CHALLENGE_CONFLICT', 'Credential challenge is no longer pending');
    });

    if (!result.duplicate) {
      for (const conversationId of new Set(
        [result.challenge, ...result.additionalChallenges].map((challenge) => challenge.conversationId)
      )) {
        this.publishConversationChanged(input.userId, conversationId);
      }
    }
    return result;
  }

  startCredentialContinuation(
    user: User,
    input: {
      conversationId: string;
      runId: string;
      challenge: AICredentialChallenge;
      authorized: boolean;
    }
  ): void {
    if (input.challenge.roundId) {
      this.executor.startToolRoundContinuation(user, {
        conversationId: input.conversationId,
        runId: input.runId,
        roundId: input.challenge.roundId,
      });
      return;
    }
    this.executor.startCredentialContinuation(user, input);
  }

  async resolveSetupInteraction(input: {
    conversationId: string;
    runId: string;
    interactionId: string;
    userId: string;
    clientCommandId: string;
    status: 'configured' | 'cancelled';
    result?: Record<string, unknown>;
  }): Promise<{ interaction: AISetupInteraction; duplicate: boolean }> {
    const resolved = await this.db.transaction(async (tx) => {
      await assertOwnedConversation(tx, input.userId, input.conversationId);
      const now = new Date();
      const result = {
        ...(input.result ?? {}),
        status: input.status,
      };
      const [updated] = await tx
        .update(aiRunSetupInteractions)
        .set({
          status: input.status,
          result,
          resolvedByUserId: input.userId,
          resolveClientCommandId: input.clientCommandId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(aiRunSetupInteractions.id, input.interactionId),
            eq(aiRunSetupInteractions.runId, input.runId),
            eq(aiRunSetupInteractions.conversationId, input.conversationId),
            eq(aiRunSetupInteractions.userId, input.userId),
            eq(aiRunSetupInteractions.status, 'pending')
          )
        )
        .returning();
      if (updated) return { interaction: updated, duplicate: false };

      const [existing] = await tx
        .select()
        .from(aiRunSetupInteractions)
        .where(
          and(
            eq(aiRunSetupInteractions.id, input.interactionId),
            eq(aiRunSetupInteractions.runId, input.runId),
            eq(aiRunSetupInteractions.conversationId, input.conversationId),
            eq(aiRunSetupInteractions.userId, input.userId)
          )
        )
        .limit(1);
      if (!existing) throw new AppError(404, 'AI_SETUP_INTERACTION_NOT_FOUND', 'Setup interaction not found');
      if (existing.status === input.status && existing.resolveClientCommandId === input.clientCommandId) {
        return { interaction: existing, duplicate: true };
      }
      throw new AppError(409, 'AI_SETUP_INTERACTION_CONFLICT', 'Setup interaction is no longer pending');
    });

    if (!resolved.duplicate) this.publishConversationChanged(input.userId, input.conversationId);
    return resolved;
  }

  startSetupContinuation(
    user: User,
    input: { conversationId: string; runId: string; interaction: AISetupInteraction }
  ): void {
    this.executor.startSetupContinuation(user, input);
  }

  async resumeResolvedCredentialContinuation(
    user: User,
    input: { conversationId: string; runId: string }
  ): Promise<boolean> {
    const [run] = await this.db
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.id, input.runId),
          eq(aiRuns.conversationId, input.conversationId),
          eq(aiRuns.userId, user.id),
          eq(aiRuns.status, 'waiting_for_credential')
        )
      )
      .limit(1);
    if (!run) return false;

    const [challenge] = await this.db
      .select()
      .from(aiRunCredentialChallenges)
      .where(
        and(
          eq(aiRunCredentialChallenges.runId, input.runId),
          eq(aiRunCredentialChallenges.conversationId, input.conversationId),
          eq(aiRunCredentialChallenges.userId, user.id),
          inArray(aiRunCredentialChallenges.status, ['authorized', 'rejected'])
        )
      )
      .orderBy(desc(aiRunCredentialChallenges.resolvedAt))
      .limit(1);
    if (!challenge) return false;

    this.startCredentialContinuation(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      challenge,
      authorized: challenge.status === 'authorized',
    });
    return true;
  }
}
