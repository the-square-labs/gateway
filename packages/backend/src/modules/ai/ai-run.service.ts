import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleClient, DrizzleExecutor } from '@/db/client.js';
import {
  type AIConversationInput,
  type AICredentialChallenge,
  type AIPlan,
  type AIRun,
  type AIRunPurpose,
  type AIRunQuestion,
  type AIRunStatus,
  type AIRunToolCall,
  type AIRunToolRound,
  type AISetupInteraction,
  type AIToolApprovalClass,
  type AIToolApprovalPolicy,
  type AIToolCallStatus,
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
import type { AIPlanRuntimeSnapshot, AIResourceReference } from './ai.types.js';
import {
  countVisibleMessages,
  deriveConversationStatus,
  getLastUserMessageAt,
  isHiddenSystemMessage,
} from './ai-conversation.service.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import type { AIPlanService } from './ai-plan.service.js';
import { mergeAIResourceReference } from './ai-resource-references.js';
import { AIRunExecutor } from './ai-run-executor.js';
import { AI_CONTINUATION_COMMAND_PREFIX, toClientCheckpoint } from './ai-run-runtime.helpers.js';

const ACTIVE_RUN_STATUSES: AIRunStatus[] = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
  'waiting_for_setup',
];

const ACTIVE_PLAN_STATUSES: AIPlan['status'][] = [
  'drafting',
  'validating',
  'awaiting_decision',
  'executing',
  'pause_requested',
  'paused',
  'verifying',
];

const PRE_EXECUTION_PLAN_STATUSES: AIPlan['status'][] = ['drafting', 'validating', 'awaiting_decision'];

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

export interface AIClientActionEvent {
  type: 'client.action';
  userId: string;
  conversationId: string;
  runId: string;
  action: Record<string, unknown>;
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

export interface StartContinuationRunInput {
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

export interface QueueConversationInputResult {
  input: AIConversationInput;
  duplicate: boolean;
  executionStarted: boolean;
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
  canContinue: boolean;
  assistantDraftContent: string | null;
  assistantDraftVersion: number | null;
  pendingApprovals: AIRunToolCall[];
  pendingQuestion: AIRunQuestion | null;
  pendingQuestions: AIRunQuestion[];
  pendingCredentialChallenge: AICredentialChallenge | null;
  pendingSetupInteraction: AISetupInteraction | null;
  toolCalls: AIRunToolCall[];
  toolRounds: AIRunToolRound[];
  pendingInputs: AIConversationInput[];
  activePlan: AIPlanRuntimeSnapshot | null;
  plans: AIPlanRuntimeSnapshot[];
}

export interface AIConversationRuntimeSnapshot {
  revision: number;
  resourceReferences: AIResourceReference[];
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
    private readonly conversationSearchService?: AIConversationSearchService,
    private readonly planService?: AIPlanService
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

  private async markToolRoundReadyIfUngated(db: DrizzleExecutor, toolCall: AIRunToolCall): Promise<boolean> {
    if (!toolCall.roundId) return true;
    return this.markRoundReadyIfUngated(db, toolCall.roundId);
  }

  private async markRoundReadyIfUngated(db: DrizzleExecutor, roundId: string): Promise<boolean> {
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

  private async markQuestionRoundReadyIfUngated(db: DrizzleExecutor, question: AIRunQuestion): Promise<boolean> {
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

    if (current.status === 'stopped') return { run: current, duplicate: true };
    throw new AppError(409, 'AI_RUN_NOT_ACTIVE', 'AI run is no longer active');
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

  private async reconcileInterruptedRunningRun(run: Pick<AIRun, 'id' | 'conversationId' | 'userId'>): Promise<boolean> {
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

  private async handleCompletedRun(user: User, run: AIRun): Promise<boolean> {
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

  private async handleFailedRun(_user: User, run: AIRun, error: string): Promise<void> {
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

  private async pausePlanAfterFailedRun(
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

  private async schedulePlanStateRun(user: User, plan: AIPlanRuntimeSnapshot, triggerId: string): Promise<void> {
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

  private async getRuntimeSnapshot(userId: string, conversationId: string): Promise<RuntimeSnapshot> {
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

  private async getToolCall(db: DrizzleExecutor, toolCallId: string): Promise<AIRunToolCall | null> {
    const rows = await db.select().from(aiRunToolCalls).where(toolCallIdentityWhere(toolCallId)).limit(1);
    return rows[0] ?? null;
  }

  private async getQuestion(
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

  private async listPendingQuestions(db: DrizzleExecutor, runId: string): Promise<AIRunQuestion[]> {
    return db
      .select()
      .from(aiRunQuestions)
      .where(and(eq(aiRunQuestions.runId, runId), eq(aiRunQuestions.status, 'pending')))
      .orderBy(asc(aiRunQuestions.createdAt));
  }

  private async listConversationToolCalls(conversationId: string): Promise<AIRunToolCall[]> {
    const toolCalls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
    return toolCalls.filter((toolCall) => toolCall.toolName !== 'send_comment');
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

  private publishClientAction(
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

function collectResourceReferences(toolCalls: AIRunToolCall[]): AIResourceReference[] {
  const references = new Map<string, AIResourceReference>();
  for (const toolCall of toolCalls) {
    if (toolCall.status !== 'completed') continue;
    for (const reference of toolCall.resourceReferences ?? []) {
      references.set(reference.refId, mergeAIResourceReference(references.get(reference.refId), reference));
    }
  }
  return [...references.values()].slice(-128);
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
