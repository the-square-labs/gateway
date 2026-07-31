import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AICredentialChallenge,
  type AIRun,
  type AIRunQuestion,
  type AIRunStatus,
  type AIRunToolCall,
  type AIToolApprovalClass,
  type AIToolApprovalPolicy,
  type AIToolCallStatus,
  aiConversationMessages,
  aiConversations,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRuns,
  aiRunToolCalls,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { countVisibleMessages, deriveConversationStatus, getLastUserMessageAt } from './ai-conversation.service.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import { AIRunExecutor } from './ai-run-executor.js';
import { toClientCheckpoint } from './ai-run-runtime.helpers.js';

const ACTIVE_RUN_STATUSES: AIRunStatus[] = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
];

export function aiUserConversationsChangedChannel(userId: string): string {
  return `ai.conversations.changed.${userId}`;
}

export interface AIConversationChangedEvent {
  userId: string;
  conversationId: string;
  invalidatedStores?: string[];
}

export interface AIAssistantDeltaEvent {
  type: 'assistant.delta';
  userId: string;
  conversationId: string;
  runId: string;
  content: string;
  version: number;
}

export interface AIAssistantCommentDeltaEvent {
  type: 'assistant.comment_delta';
  userId: string;
  conversationId: string;
  runId: string;
  content: string;
  version: number;
}

export interface AIAssistantCommentDoneEvent {
  type: 'assistant.comment_done';
  userId: string;
  conversationId: string;
  runId: string;
}

export interface AICredentialRequiredEvent {
  type: 'credential.required';
  userId: string;
  conversationId: string;
  runId: string;
  challenge: AICredentialChallenge;
}

export interface CreateAIRunInput {
  conversationId: string;
  userId: string;
  clientCommandId: string;
  activeMessageId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartUserRunInput {
  conversationId?: string | null;
  userId: string;
  title: string;
  userMessage: Record<string, unknown>;
  clientCommandId: string;
  lastContext?: Record<string, unknown> | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartContextCompactionInput {
  conversationId: string;
  userId: string;
  clientCommandId: string;
  lastContext?: Record<string, unknown> | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

export interface StartUserRunResult {
  conversationId: string;
  userMessageId: string | null;
  run: AIRun;
  duplicate: boolean;
}

export interface RecordToolCallInput {
  runId: string;
  conversationId: string;
  assistantMessageId?: string | null;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  classification: AIToolApprovalClass;
  approvalPolicy: AIToolApprovalPolicy;
  requiredScopes?: string[];
  status?: AIToolCallStatus;
}

export interface RuntimeSnapshot {
  activeRun: AIRun | null;
  assistantDraftContent: string | null;
  assistantDraftVersion: number | null;
  pendingApprovals: AIRunToolCall[];
  pendingQuestion: AIRunQuestion | null;
  pendingQuestions: AIRunQuestion[];
  pendingCredentialChallenge: AICredentialChallenge | null;
  toolCalls: AIRunToolCall[];
}

export interface AIConversationRuntimeSnapshot {
  conversation: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    folderId: string | null;
    lastUserMessageAt: Date | null;
    messageCount: number;
    status: 'active' | 'ended' | 'context_blocked';
    blockReason: string | null;
    model: string | null;
    reasoningEffort: string | null;
    lastContext: Record<string, unknown> | null;
    discoveredToolsets: string[];
    checkpoint: Record<string, unknown> | null;
  };
  messages: unknown[];
  runtime: RuntimeSnapshot;
}

export class AIRunService {
  private readonly executor: AIRunExecutor;

  constructor(
    private readonly db: DrizzleClient,
    private readonly eventBus?: EventBusService,
    private readonly conversationSearchService?: AIConversationSearchService
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
        this.publishCredentialChallenge(userId, conversationId, runId, challenge)
    );
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
        .values(toConversationMessage(conversation.id, input.userMessage, sequence))
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
  }): Promise<{ toolCall: AIRunToolCall; duplicate: boolean }> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const nextStatus = input.decision === 'approved' ? 'approved' : 'rejected';
    const now = new Date();
    const [updated] = await this.db
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
      this.publishConversationChanged(input.userId, input.conversationId);
      return { toolCall: updated, duplicate: false };
    }

    const existing = await this.getToolCall(input.toolCallId);
    if (!existing) throw new AppError(404, 'AI_TOOL_CALL_NOT_FOUND', 'AI tool call not found');
    if (existing.runId !== input.runId || existing.conversationId !== input.conversationId) {
      throw new AppError(404, 'AI_TOOL_CALL_NOT_FOUND', 'AI tool call not found');
    }
    if (existing.decision === input.decision && (existing.status === 'approved' || existing.status === 'rejected')) {
      return { toolCall: existing, duplicate: true };
    }
    throw new AppError(409, 'AI_TOOL_CALL_DECISION_CONFLICT', 'Tool call is no longer pending approval');
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
  }): Promise<{ question: AIRunQuestion; duplicate: boolean; remainingPendingQuestions: AIRunQuestion[] }> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const now = new Date();
    const [updated] = await this.db
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
      this.publishConversationChanged(input.userId, input.conversationId);
      return {
        question: updated,
        duplicate: false,
        remainingPendingQuestions: await this.listPendingQuestions(input.runId),
      };
    }

    const existing = await this.getQuestion(input.questionId, input.runId, input.conversationId);
    if (!existing) throw new AppError(404, 'AI_QUESTION_NOT_FOUND', 'AI question not found');
    if (existing.runId !== input.runId || existing.conversationId !== input.conversationId) {
      throw new AppError(404, 'AI_QUESTION_NOT_FOUND', 'AI question not found');
    }
    if (existing.status === 'answered' && existing.answer === input.answer) {
      return {
        question: existing,
        duplicate: true,
        remainingPendingQuestions: await this.listPendingQuestions(input.runId),
      };
    }
    throw new AppError(409, 'AI_QUESTION_ANSWER_CONFLICT', 'Question is no longer pending');
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
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const now = new Date();
    const [updated] = await this.db
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
          ? await this.db
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
      for (const conversationId of new Set(
        [updated, ...additionalChallenges].map((challenge) => challenge.conversationId)
      )) {
        this.publishConversationChanged(input.userId, conversationId);
      }
      return { challenge: updated, additionalChallenges, duplicate: false };
    }

    const [existing] = await this.db
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
      return { challenge: existing, additionalChallenges: [], duplicate: true };
    }
    throw new AppError(409, 'AI_CREDENTIAL_CHALLENGE_CONFLICT', 'Credential challenge is no longer pending');
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
    this.executor.startCredentialContinuation(user, input);
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

    this.executor.startCredentialContinuation(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      challenge,
      authorized: challenge.status === 'authorized',
    });
    return true;
  }

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
    if (current.activeMessageId === null && ACTIVE_RUN_STATUSES.includes(current.status)) {
      throw new AppError(409, 'AI_COMPACTION_ACTIVE', 'Context compaction cannot be stopped');
    }

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
      ]);
      this.publishConversationChanged(input.userId, input.conversationId);
      return { run: stopped, duplicate: false };
    }

    if (current.status === 'stopped') return { run: current, duplicate: true };
    throw new AppError(409, 'AI_RUN_NOT_ACTIVE', 'AI run is no longer active');
  }

  async stopActiveRunForRollback(input: {
    conversationId: string;
    userId: string;
  }): Promise<{ run: AIRun; duplicate: boolean } | null> {
    await assertOwnedConversation(this.db, input.userId, input.conversationId);
    const activeRun = await this.getActiveRun(input.conversationId);
    if (!activeRun) return null;
    if (activeRun.activeMessageId === null) {
      throw new AppError(409, 'AI_COMPACTION_ACTIVE', 'Context compaction cannot be stopped');
    }
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

  startRunExecution(user: User, runId: string): void {
    this.executor.startRunExecution(user, runId);
  }

  startContextCompaction(user: User, runId: string, trigger: 'manual' | 'auto'): void {
    this.executor.startContextCompaction(user, runId, trigger);
  }

  async getRuntimeSnapshot(conversationId: string): Promise<RuntimeSnapshot> {
    const activeRun = await this.getActiveRun(conversationId);
    if (!activeRun) {
      return {
        activeRun: null,
        assistantDraftContent: null,
        assistantDraftVersion: null,
        pendingApprovals: [],
        pendingQuestion: null,
        pendingQuestions: [],
        pendingCredentialChallenge: null,
        toolCalls: await this.listConversationToolCalls(conversationId),
      };
    }

    const [activeToolCalls, questions, challenges, toolCalls] = await Promise.all([
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
      this.listConversationToolCalls(conversationId),
    ]);
    const pendingQuestions = questions.filter((question) => question.status === 'pending');
    const liveDraft = this.executor.getAssistantDraft(activeRun.id);
    const assistantDraftContent = liveDraft?.content ?? activeRun.assistantDraftContent ?? null;

    return {
      activeRun,
      assistantDraftContent,
      assistantDraftVersion: liveDraft?.version ?? (assistantDraftContent ? 0 : null),
      pendingApprovals: activeToolCalls.filter((toolCall) => toolCall.status === 'pending_approval'),
      pendingQuestion: pendingQuestions[0] ?? null,
      pendingQuestions,
      pendingCredentialChallenge: challenges[0] ?? null,
      toolCalls,
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
      this.getRuntimeSnapshot(conversationId),
    ]);

    const snapshotMessages = messages.map((message) =>
      toSnapshotMessage(message.id, message.sequence, message.uiMessage, message.createdAt)
    );
    const uiMessages = snapshotMessages;
    const loadedMessageRows = messages.map((message) => ({
      role: readMessageRole(message.uiMessage),
      uiMessage: message.uiMessage,
      createdAt: message.createdAt,
    }));

    return {
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

  private async findRunByCommand(
    userId: string,
    conversationId: string,
    clientCommandId: string
  ): Promise<AIRun | null> {
    return findRunByCommand(this.db, userId, conversationId, clientCommandId);
  }

  private async findRunByUserCommand(userId: string, clientCommandId: string): Promise<AIRun | null> {
    return findRunByUserCommand(this.db, userId, clientCommandId);
  }

  private async getToolCall(toolCallId: string): Promise<AIRunToolCall | null> {
    const rows = await this.db.select().from(aiRunToolCalls).where(toolCallIdentityWhere(toolCallId)).limit(1);
    return rows[0] ?? null;
  }

  private async getQuestion(questionId: string, runId: string, conversationId: string): Promise<AIRunQuestion | null> {
    const rows = await this.db
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

  private async listPendingQuestions(runId: string): Promise<AIRunQuestion[]> {
    return this.db
      .select()
      .from(aiRunQuestions)
      .where(and(eq(aiRunQuestions.runId, runId), eq(aiRunQuestions.status, 'pending')))
      .orderBy(asc(aiRunQuestions.createdAt));
  }

  private async listConversationToolCalls(conversationId: string): Promise<AIRunToolCall[]> {
    return this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
  }

  private publishConversationChanged(userId: string, conversationId: string, invalidatedStores?: string[]): void {
    const event = {
      userId,
      conversationId,
      ...(invalidatedStores?.length ? { invalidatedStores } : {}),
    } satisfies AIConversationChangedEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  private publishAssistantDelta(
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

  private publishAssistantCommentDelta(
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

  private publishAssistantCommentDone(userId: string, conversationId: string, runId: string): void {
    const event = {
      type: 'assistant.comment_done',
      userId,
      conversationId,
      runId,
    } satisfies AIAssistantCommentDoneEvent;
    this.eventBus?.publish(aiUserConversationsChangedChannel(userId), event);
  }

  private publishCredentialChallenge(
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
}

type DbLike = Pick<DrizzleClient, 'select' | 'insert' | 'update'>;

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toolCallIdentityWhere(value: string) {
  return isUuidLike(value)
    ? or(eq(aiRunToolCalls.id, value), eq(aiRunToolCalls.toolCallId, value))
    : eq(aiRunToolCalls.toolCallId, value);
}

function questionIdentityWhere(value: string) {
  return isUuidLike(value)
    ? or(eq(aiRunQuestions.id, value), eq(aiRunQuestions.toolCallId, value))
    : eq(aiRunQuestions.toolCallId, value);
}

function normalizeConversationTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new AppError(400, 'AI_CONVERSATION_TITLE_REQUIRED', 'Conversation title is required');
  return normalized.slice(0, 255);
}

async function getOwnedConversation(db: DbLike, userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function assertOwnedConversation(db: DbLike, userId: string, conversationId: string): Promise<void> {
  const conversation = await getOwnedConversation(db, userId, conversationId);
  if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
}

async function createConversation(
  db: DbLike,
  input: {
    userId: string;
    title: string;
    lastContext: Record<string, unknown> | null;
    model: string | null;
    reasoningEffort: string | null;
  }
) {
  const [conversation] = await db
    .insert(aiConversations)
    .values({
      userId: input.userId,
      title: input.title,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      lastContext: input.lastContext,
      discoveredToolsets: [],
      updatedAt: new Date(),
    })
    .returning();
  return conversation;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

async function resolveUniqueTitle(db: DbLike, userId: string, title: string): Promise<string> {
  let candidate = title;
  for (let copy = 2; ; copy += 1) {
    const rows = await db
      .select({ id: aiConversations.id })
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.title, candidate)))
      .limit(1);
    if (rows.length === 0) return candidate;

    const suffix = ` (${copy})`;
    candidate = `${title.slice(0, 255 - suffix.length)}${suffix}`;
  }
}

async function findRunByCommand(
  db: DbLike,
  userId: string,
  conversationId: string,
  clientCommandId: string
): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.userId, userId),
        eq(aiRuns.conversationId, conversationId),
        eq(aiRuns.clientCommandId, clientCommandId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findRunByUserCommand(db: DbLike, userId: string, clientCommandId: string): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.userId, userId), eq(aiRuns.clientCommandId, clientCommandId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForUpdate(db: DbLike, conversationId: string): Promise<AIRun | null> {
  const rows = await db
    .select()
    .from(aiRuns)
    .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, ACTIVE_RUN_STATUSES)))
    .orderBy(desc(aiRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function assertConversationCanAcceptUserTurn(db: DbLike, conversationId: string): Promise<void> {
  const rows = await db
    .select({ uiMessage: aiConversationMessages.uiMessage })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(50);
  const status = deriveConversationStatus(rows.map((row) => row.uiMessage));
  if (status.status === 'ended') {
    throw new AppError(409, 'AI_CONVERSATION_ENDED', status.blockReason ?? 'This conversation has ended');
  }
  if (status.status === 'context_blocked') {
    throw new AppError(409, 'AI_CONVERSATION_CONTEXT_BLOCKED', status.blockReason ?? 'This conversation is blocked');
  }
}

async function assertConversationCanCompact(db: DbLike, conversationId: string): Promise<void> {
  const rows = await db
    .select({ uiMessage: aiConversationMessages.uiMessage })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(50);
  const status = deriveConversationStatus(rows.map((row) => row.uiMessage));
  if (status.status === 'ended') {
    throw new AppError(409, 'AI_CONVERSATION_ENDED', status.blockReason ?? 'This conversation has ended');
  }
}

async function nextMessageSequence(db: DbLike, conversationId: string): Promise<number> {
  const rows = await db
    .select({ sequence: aiConversationMessages.sequence })
    .from(aiConversationMessages)
    .where(eq(aiConversationMessages.conversationId, conversationId))
    .orderBy(desc(aiConversationMessages.sequence))
    .limit(1);
  return (rows[0]?.sequence ?? -1) + 1;
}

function toConversationMessage(conversationId: string, message: Record<string, unknown>, sequence: number) {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : null;
  return {
    conversationId,
    sequence,
    role: typeof message.role === 'string' ? message.role : 'user',
    content: typeof message.content === 'string' ? message.content : '',
    uiMessage: { ...message, role: typeof message.role === 'string' ? message.role : 'user' },
    toolCalls,
    toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : null,
    toolName: typeof message.toolName === 'string' ? message.toolName : null,
    toolArgsCompact: null,
    toolResultRaw: null,
    toolResultCompact: null,
    toolResultSizeBytes: estimateJsonSize(toolCalls),
    isSensitive: false,
  };
}

function toSnapshotMessage(id: string, sequence: number, uiMessage: unknown, createdAt: Date): Record<string, unknown> {
  if (!uiMessage || typeof uiMessage !== 'object' || Array.isArray(uiMessage)) {
    return { id, sequence, content: String(uiMessage ?? ''), createdAt: createdAt.toISOString() };
  }
  return {
    ...(uiMessage as Record<string, unknown>),
    id,
    sequence,
    createdAt: createdAt.toISOString(),
  };
}

function readMessageRole(uiMessage: unknown): string {
  if (!uiMessage || typeof uiMessage !== 'object' || Array.isArray(uiMessage)) return '';
  const role = (uiMessage as Record<string, unknown>).role;
  return typeof role === 'string' ? role : '';
}

function withAssistantDraftMessage(
  messages: Record<string, unknown>[],
  activeRun: AIRun | null,
  assistantDraftContent: string | null
): Record<string, unknown>[] {
  const content = assistantDraftContent;
  if (!content || !activeRun) return messages;
  const sequence =
    messages.reduce(
      (max, message, index) => Math.max(max, typeof message.sequence === 'number' ? message.sequence : index),
      -1
    ) + 1;
  return [
    ...messages,
    {
      id: `${activeRun.id}:draft`,
      sequence,
      role: 'assistant',
      content,
      createdAt: activeRun.updatedAt.toISOString(),
      isStreaming: true,
    },
  ];
}

function estimateJsonSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}
