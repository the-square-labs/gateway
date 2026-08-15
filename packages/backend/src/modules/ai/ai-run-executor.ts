import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AIConversationInput,
  type AICredentialChallenge,
  type AIRun,
  type AIRunQuestion,
  type AIRunToolCall,
  type AISetupInteraction,
  aiConversationInputs,
  aiConversationMessages,
  aiConversations,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRunSetupInteractions,
  aiRuns,
  aiRunToolCalls,
  aiRunToolRounds,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { type AIContextCompactionResult, type AIContextCompactionTrigger, AIService } from './ai.service.js';
import type { AIResourceReference, ChatMessage, WSServerMessage } from './ai.types.js';
import { classifyAIToolForApproval } from './ai-approval-policy.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import { type AssistantLiveDraft, AssistantLiveDraftStore } from './ai-live-draft-store.js';
import { AIPlanService } from './ai-plan.service.js';
import {
  appendAIResourceReferencesToModelResult,
  formatAIResourceMarker,
  mergeAIResourceReference,
  referencedAIResourceIds,
} from './ai-resource-references.js';
import {
  isAIContinuationCommand,
  normalizeCheckpoint,
  questionTextFromArgs,
  toChatMessage,
  toCheckpoint,
  toPageContext,
} from './ai-run-runtime.helpers.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

const logger = createChildLogger('AI-Run-Executor');
const ACTIVE_RUN_STATUSES: AIRun['status'][] = [
  'queued',
  'running',
  'waiting_for_approval',
  'waiting_for_answer',
  'waiting_for_credential',
  'waiting_for_setup',
];
const STEER_DEBOUNCE_MS = 1_000;
const STEER_MAX_WAIT_MS = 3_000;

function getClientAction(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const action = (result as { clientAction?: unknown }).clientAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action as Record<string, unknown>;
}

function getSetupInteractionKind(action: Record<string, unknown> | null): AISetupInteraction['kind'] | null {
  if (action?.type === 'open_connector_setup') return 'connector_setup';
  if (action?.type === 'open_node_enrollment') return 'node_enrollment';
  return null;
}

type PublishConversationChanged = (userId: string, conversationId: string, invalidatedStores?: string[]) => void;
type PublishAssistantDelta = (
  userId: string,
  conversationId: string,
  runId: string,
  content: string,
  version: number
) => void;
type PublishAssistantCommentDelta = PublishAssistantDelta;
type PublishAssistantCommentDone = (userId: string, conversationId: string, runId: string) => void;
type PublishCredentialChallenge = (
  userId: string,
  conversationId: string,
  runId: string,
  challenge: AICredentialChallenge
) => void;
type PublishClientAction = (
  userId: string,
  conversationId: string,
  runId: string,
  action: Record<string, unknown>
) => void;
type HandleCompletedRun = (user: User, run: AIRun) => Promise<boolean>;
type HandleFailedRun = (user: User, run: AIRun, error: string) => Promise<void>;

interface ApprovalContinuationInput {
  conversationId: string;
  runId: string;
  toolCall: AIRunToolCall;
  approved: boolean;
}

interface QuestionContinuationInput {
  conversationId: string;
  runId: string;
  question: AIRunQuestion;
}

interface CredentialContinuationInput {
  conversationId: string;
  runId: string;
  challenge: AICredentialChallenge;
  authorized: boolean;
}

interface SetupContinuationInput {
  conversationId: string;
  runId: string;
  interaction: AISetupInteraction;
}

interface ResumeInput {
  conversationId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  approved: boolean;
  pendingMessages: Record<string, unknown>[];
  answers?: Record<string, string>;
  queuedApprovals: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  approvalDecisions?: Record<string, boolean>;
  rejectionError?: string;
  precomputedResult?: {
    result: Record<string, unknown>;
    error?: string;
    rejected?: boolean;
  };
}

export class AIRunExecutor {
  private readonly leaseOwner = `gateway-ai-${process.pid}-${randomUUID()}`;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly executingRuns = new Set<string>();
  private readonly executionEpochs = new Map<string, number>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly assistantLiveDrafts = new AssistantLiveDraftStore();
  private readonly toolBoundaryMessageIds = new Map<string, string>();
  private readonly pendingInputDispatches = new Set<string>();
  private readonly pendingInputRedispatches = new Set<string>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly publishConversationChanged: PublishConversationChanged,
    private readonly publishAssistantDelta: PublishAssistantDelta,
    private readonly publishAssistantCommentDelta: PublishAssistantCommentDelta,
    private readonly publishAssistantCommentDone: PublishAssistantCommentDone,
    private readonly conversationSearchService?: AIConversationSearchService,
    private readonly publishCredentialChallenge?: PublishCredentialChallenge,
    private readonly publishClientAction?: PublishClientAction,
    private readonly handleCompletedRun?: HandleCompletedRun,
    private readonly handleFailedRun?: HandleFailedRun
  ) {}

  startRunExecution(user: User, runId: string): void {
    if (this.executingRuns.has(runId)) return;
    this.executingRuns.add(runId);
    void this.executeRun(user, runId).catch((error) => {
      this.logExecutionError(runId, error);
    });
  }

  startPendingInputExecution(user: User, conversationId: string): void {
    if (this.pendingInputDispatches.has(conversationId)) {
      this.pendingInputRedispatches.add(conversationId);
      return;
    }
    this.pendingInputDispatches.add(conversationId);
    void this.dispatchNextPendingInput(user, conversationId)
      .catch((error) => this.logExecutionError(`pending-input:${conversationId}`, error))
      .finally(() => {
        this.pendingInputDispatches.delete(conversationId);
        if (this.pendingInputRedispatches.delete(conversationId)) {
          this.startPendingInputExecution(user, conversationId);
        }
      });
  }

  startApprovalContinuation(user: User, input: ApprovalContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeApprovalContinuation(user, input).catch((error) => {
      this.logExecutionError(input.runId, error);
    });
  }

  startToolRoundContinuation(user: User, input: { conversationId: string; runId: string; roundId: string }): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeToolRoundContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startQuestionContinuation(user: User, input: QuestionContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeQuestionContinuation(user, input).catch((error) => {
      this.logExecutionError(input.runId, error);
    });
  }

  startCredentialContinuation(user: User, input: CredentialContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeCredentialContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startSetupContinuation(user: User, input: SetupContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeSetupContinuation(user, input).catch((error) => {
      this.executingRuns.delete(input.runId);
      this.logExecutionError(input.runId, error);
    });
  }

  startContextCompaction(user: User, runId: string, trigger: AIContextCompactionTrigger): void {
    if (this.executingRuns.has(runId)) return;
    this.executingRuns.add(runId);
    void this.executeContextCompaction(user, runId, trigger).catch((error) => {
      this.logExecutionError(runId, error);
    });
  }

  abortRun(runId: string): void {
    this.abortControllers.get(runId)?.abort();
    this.abortControllers.delete(runId);
    this.executingRuns.delete(runId);
    this.toolBoundaryMessageIds.delete(runId);
    void this.releaseLease(runId);
  }

  async waitForIdle(deadline: number): Promise<void> {
    while ((this.executingRuns.size > 0 || this.pendingInputDispatches.size > 0) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())));
        timer.unref?.();
      });
    }
  }

  getAssistantDraft(runId: string): AssistantLiveDraft | null {
    return this.assistantLiveDrafts.get(runId);
  }

  async flushAssistantDraftToMessage(
    userId: string,
    conversationId: string,
    runId: string,
    fallbackContent?: string | null
  ): Promise<string | null> {
    const content = this.assistantLiveDrafts.getContent(runId, fallbackContent);
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(userId, conversationId, runId, content);
    if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(runId, assistantMessageId);
    this.assistantLiveDrafts.forget(runId);
    await this.clearAssistantDraft(runId);
    return assistantMessageId;
  }

  private async executeRun(user: User, runId: string): Promise<void> {
    const run = await this.getOwnedRun(user.id, runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (run.status !== 'queued') return;

    const conversation = await getOwnedConversation(this.db, user.id, run.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (!(await this.claimRun(run, ['queued']))) return;
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    this.publishConversationChanged(user.id, run.conversationId);

    const pageContext = toPageContext(conversation.lastContext);
    const aiService = container.resolve(AIService);
    const messages = await this.loadConversationMessages(run.conversationId, {
      includeHistoricalToolOutcomes: true,
    });
    if (isAIContinuationCommand(run.clientCommandId)) {
      messages.push({
        role: 'user',
        content:
          'Continue the interrupted task from the current durable state. Do not repeat successful side effects. Verify uncertain effects before acting, then complete the task and provide the final response.',
      });
    }
    let assistantContent = '';
    let assistantMessageWritten = false;

    try {
      for await (const event of aiService.streamChat(
        user,
        messages,
        pageContext,
        abortController.signal,
        run.id,
        run.conversationId,
        (currentMessages) => this.maybeAutoCompactContext(user, run, currentMessages, pageContext, abortController),
        run.model ?? undefined,
        run.reasoningEffort ?? undefined,
        (currentMessages) => this.receivePendingSteers(user, run, currentMessages, abortController.signal)
      )) {
        if (abortController.signal.aborted) return;

        const result = await this.applyRuntimeEvent({
          user,
          run,
          event,
          assistantContent,
          assistantMessageWritten,
        });
        assistantContent = result.assistantContent;
        assistantMessageWritten = result.assistantMessageWritten;
        if (result.done) return;
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isPlanPauseBoundaryError(error)) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          run.conversationId,
          run.id,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
        await this.updateRunStatus(run.id, 'stopped');
        this.forgetAssistantDraftState(run.id);
        this.publishConversationChanged(user.id, run.conversationId);
        return;
      }
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      const errorMessage = error instanceof Error ? error.message : 'AI run failed';
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(run.id);
      await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
    } finally {
      this.abortControllers.delete(run.id);
      this.executingRuns.delete(run.id);
      this.toolBoundaryMessageIds.delete(run.id);
      await this.releaseLease(run.id);
    }
  }

  private async executeApprovalContinuation(user: User, input: ApprovalContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const pendingApproval =
      checkpoint.pendingApproval?.id === input.toolCall.toolCallId &&
      checkpoint.pendingApproval.name === input.toolCall.toolName
        ? checkpoint.pendingApproval
        : null;
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      toolArgs: pendingApproval?.arguments ?? input.toolCall.toolArgs,
      approved: input.approved,
      pendingMessages: checkpoint.pendingMessages,
      queuedApprovals: checkpoint.queuedApprovals,
    });
  }

  private async executeToolRoundContinuation(
    user: User,
    input: { conversationId: string; runId: string; roundId: string }
  ): Promise<void> {
    const [round] = await this.db
      .select()
      .from(aiRunToolRounds)
      .where(
        and(
          eq(aiRunToolRounds.id, input.roundId),
          eq(aiRunToolRounds.runId, input.runId),
          eq(aiRunToolRounds.conversationId, input.conversationId)
        )
      )
      .limit(1);
    if (!round || round.status !== 'ready') {
      this.executingRuns.delete(input.runId);
      return;
    }
    const calls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, input.roundId))
      .orderBy(asc(aiRunToolCalls.position));
    const questions = await this.db
      .select()
      .from(aiRunQuestions)
      .where(eq(aiRunQuestions.roundId, input.roundId))
      .orderBy(asc(aiRunQuestions.position));
    const credentialChallenges = await this.db
      .select()
      .from(aiRunCredentialChallenges)
      .where(eq(aiRunCredentialChallenges.roundId, input.roundId));
    const answers = Object.fromEntries(
      questions.map((question) => [question.toolCallId, question.answer ?? 'No answer provided'])
    );
    const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'effect_unknown']);
    const remainingCalls = calls.filter((call) => !terminalStatuses.has(call.status));
    const firstQuestion = questions.find((question) => question.status === 'answered');
    const firstCall = firstQuestion
      ? remainingCalls.find((call) => call.toolCallId === firstQuestion.toolCallId)
      : remainingCalls[0];
    const credentialDecisions = new Map(
      credentialChallenges.map((challenge) => [challenge.toolCallId, challenge.status === 'authorized'])
    );
    const approvalDecisions = Object.fromEntries(
      remainingCalls.map((call) => [
        call.toolCallId,
        call.status === 'rejected'
          ? false
          : credentialDecisions.has(call.toolCallId)
            ? credentialDecisions.get(call.toolCallId) === true
            : true,
      ])
    );
    const first = firstQuestion
      ? {
          id: firstQuestion.toolCallId,
          name: 'ask_question',
          args: firstCall?.toolArgs ?? {
            question: firstQuestion.question,
          },
          approved: true,
        }
      : firstCall
        ? {
            id: firstCall.toolCallId,
            name: firstCall.toolName,
            args: firstCall.toolArgs,
            approved: approvalDecisions[firstCall.toolCallId] !== false,
          }
        : null;
    if (!first) {
      this.executingRuns.delete(input.runId);
      return;
    }
    const queuedApprovals = remainingCalls
      .filter((call) => call.toolCallId !== first.id && call.toolName !== 'ask_question')
      .map((call) => ({ id: call.toolCallId, name: call.toolName, arguments: call.toolArgs }));
    await this.db
      .update(aiRunToolRounds)
      .set({ status: 'executing', startedAt: round.startedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(aiRunToolRounds.id, input.roundId), eq(aiRunToolRounds.status, 'ready')));
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: first.id,
      toolName: first.name,
      toolArgs: first.args,
      approved: first.approved,
      pendingMessages: round.providerMessages,
      answers: firstQuestion ? answers : undefined,
      queuedApprovals,
      approvalDecisions,
    });
  }

  private async executeQuestionContinuation(user: User, input: QuestionContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const answeredQuestions = await this.listAnsweredQuestions(input.runId);
    const answers = Object.fromEntries(
      answeredQuestions.map((question) => [question.toolCallId, question.answer ?? 'No answer provided'])
    );
    if (!answers[input.question.toolCallId]) {
      answers[input.question.toolCallId] = input.question.answer ?? 'No answer provided';
    }
    const firstQuestion = checkpoint.allQuestions[0] ?? {
      id: input.question.toolCallId,
      args: { question: input.question.question },
    };
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: firstQuestion.id,
      toolName: 'ask_question',
      toolArgs: firstQuestion.args,
      approved: true,
      pendingMessages: checkpoint.pendingMessages,
      answers,
      queuedApprovals: checkpoint.queuedApprovals,
    });
  }

  private async executeCredentialContinuation(user: User, input: CredentialContinuationInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(user.id, input.conversationId);
    const pending = checkpoint.pendingCredential;
    if (
      !pending ||
      pending.id !== input.challenge.toolCallId ||
      pending.name !== input.challenge.toolName ||
      pending.connectorId !== input.challenge.connectorId
    ) {
      throw new AppError(409, 'AI_CREDENTIAL_CHECKPOINT_MISMATCH', 'Credential challenge is no longer active');
    }
    const decidedApprovals = await this.db
      .select({ toolCallId: aiRunToolCalls.toolCallId, status: aiRunToolCalls.status })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, input.runId), inArray(aiRunToolCalls.status, ['approved', 'rejected'])));
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: pending.id,
      toolName: pending.name,
      toolArgs: pending.arguments,
      approved: input.authorized,
      pendingMessages: checkpoint.pendingMessages,
      queuedApprovals: checkpoint.queuedApprovals,
      approvalDecisions: Object.fromEntries(
        decidedApprovals.map((call) => [call.toolCallId, call.status === 'approved'])
      ),
      rejectionError: input.authorized
        ? undefined
        : 'GITLAB_AUTHORIZATION_REJECTED: User rejected GitLab authorization.',
    });
  }

  private async executeSetupContinuation(user: User, input: SetupContinuationInput): Promise<void> {
    if (input.interaction.status !== 'configured' && input.interaction.status !== 'cancelled') {
      this.executingRuns.delete(input.runId);
      return;
    }
    if (!input.interaction.roundId) {
      this.executingRuns.delete(input.runId);
      throw new AppError(409, 'AI_SETUP_CHECKPOINT_MISSING', 'Setup interaction continuation is unavailable');
    }

    const [round] = await this.db
      .select()
      .from(aiRunToolRounds)
      .where(
        and(
          eq(aiRunToolRounds.id, input.interaction.roundId),
          eq(aiRunToolRounds.runId, input.runId),
          eq(aiRunToolRounds.conversationId, input.conversationId)
        )
      )
      .limit(1);
    if (!round) {
      this.executingRuns.delete(input.runId);
      throw new AppError(409, 'AI_SETUP_CHECKPOINT_MISSING', 'Setup interaction continuation is unavailable');
    }

    const calls = await this.db
      .select()
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, round.id))
      .orderBy(asc(aiRunToolCalls.position));
    const terminalStatuses = new Set(['completed', 'failed', 'rejected', 'stopped', 'effect_unknown']);
    const remainingCalls = calls.filter(
      (call) => call.toolCallId !== input.interaction.toolCallId && !terminalStatuses.has(call.status)
    );
    const approvalDecisions = Object.fromEntries(
      remainingCalls.flatMap((call) => {
        if (
          call.toolName !== 'ask_question' &&
          (call.approvalPolicy === 'auto_approved' || call.approvalPolicy === 'system_skipped')
        ) {
          return [[call.toolCallId, true] as const];
        }
        if (call.status === 'approved' || call.status === 'rejected') {
          return [[call.toolCallId, call.status === 'approved'] as const];
        }
        return [];
      })
    );
    const result = {
      status: input.interaction.status,
      ...(input.interaction.result ?? {}),
      message:
        input.interaction.status === 'configured'
          ? 'Setup completed. Re-check the prerequisite before continuing.'
          : 'Setup was cancelled. Offer the next viable path without treating missing setup as a terminal blocker.',
    };

    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: input.interaction.toolCallId,
      toolName: input.interaction.toolName,
      toolArgs: input.interaction.payload,
      approved: true,
      pendingMessages: round.providerMessages,
      queuedApprovals: remainingCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        arguments: call.toolArgs,
      })),
      approvalDecisions,
      precomputedResult: { result },
    });
  }

  private async executeResume(user: User, input: ResumeInput): Promise<void> {
    const run = await this.getOwnedRun(user.id, input.runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (
      run.status !== 'waiting_for_approval' &&
      run.status !== 'waiting_for_answer' &&
      run.status !== 'waiting_for_credential' &&
      run.status !== 'waiting_for_setup'
    ) {
      return;
    }

    const conversation = await getOwnedConversation(this.db, user.id, input.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (
      !(await this.claimRun(run, [
        'waiting_for_approval',
        'waiting_for_answer',
        'waiting_for_credential',
        'waiting_for_setup',
        'queued',
      ]))
    ) {
      return;
    }
    const abortController = new AbortController();
    this.abortControllers.set(input.runId, abortController);
    this.publishConversationChanged(user.id, input.conversationId);

    const aiService = container.resolve(AIService);
    const pageContext = toPageContext(conversation.lastContext);
    let assistantContent = '';
    let assistantMessageWritten = false;

    try {
      for await (const event of aiService.resumeAfterApproval(
        user,
        input.toolCallId,
        input.toolName,
        input.toolArgs,
        input.approved,
        input.pendingMessages,
        pageContext,
        abortController.signal,
        input.runId,
        undefined,
        input.answers,
        input.queuedApprovals,
        input.conversationId,
        (currentMessages) => this.maybeAutoCompactContext(user, run, currentMessages, pageContext, abortController),
        input.rejectionError,
        run.model ?? undefined,
        run.reasoningEffort ?? undefined,
        input.approvalDecisions,
        (currentMessages) => this.receivePendingSteers(user, run, currentMessages, abortController.signal),
        input.precomputedResult
      )) {
        if (abortController.signal.aborted) return;

        const result = await this.applyRuntimeEvent({
          user,
          run,
          event,
          assistantContent,
          assistantMessageWritten,
        });
        assistantContent = result.assistantContent;
        assistantMessageWritten = result.assistantMessageWritten;
        if (result.done) return;
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (isPlanPauseBoundaryError(error)) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          input.conversationId,
          input.runId,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
        await this.updateRunStatus(input.runId, 'stopped');
        this.forgetAssistantDraftState(input.runId);
        this.publishConversationChanged(user.id, input.conversationId);
        return;
      }
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        input.conversationId,
        input.runId,
        assistantContent
      );
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
      const errorMessage = error instanceof Error ? error.message : 'AI run failed';
      await this.updateRunStatus(input.runId, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(input.runId);
      await this.persistRunErrorMessage(user.id, input.conversationId, input.runId, errorMessage);
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(input.runId);
      this.publishConversationChanged(user.id, input.conversationId);
    } finally {
      this.abortControllers.delete(input.runId);
      this.executingRuns.delete(input.runId);
      this.toolBoundaryMessageIds.delete(input.runId);
      await this.releaseLease(input.runId);
    }
  }

  private async executeContextCompaction(
    user: User,
    runId: string,
    trigger: AIContextCompactionTrigger
  ): Promise<void> {
    const run = await this.getOwnedRun(user.id, runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (run.status !== 'queued') return;

    const conversation = await getOwnedConversation(this.db, user.id, run.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    if (!(await this.claimRun(run, ['queued']))) return;
    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    this.publishConversationChanged(user.id, run.conversationId);

    try {
      const messages = await this.loadConversationMessages(run.conversationId, {
        includeHistoricalToolOutcomes: true,
      });
      const pageContext = toPageContext(conversation.lastContext);
      await this.performContextCompaction(user, run, messages, pageContext, abortController, trigger, true);
      await this.updateRunStatus(run.id, 'completed');
      await this.setConversationCheckpoint(run.conversationId, null);
      this.publishConversationChanged(user.id, run.conversationId);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : 'Context compaction failed';
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      this.publishConversationChanged(user.id, run.conversationId);
    } finally {
      this.abortControllers.delete(run.id);
      this.executingRuns.delete(run.id);
      this.toolBoundaryMessageIds.delete(run.id);
      await this.releaseLease(run.id);
    }
  }

  private async applyRuntimeEvent(input: {
    user: User;
    run: AIRun;
    event: WSServerMessage;
    assistantContent: string;
    assistantMessageWritten: boolean;
  }): Promise<{ assistantContent: string; assistantMessageWritten: boolean; done: boolean }> {
    let { assistantContent, assistantMessageWritten } = input;
    const { user, run, event } = input;

    if (event.type === 'text_delta') {
      assistantContent += event.content;
      const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
      this.publishAssistantDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'assistant_comment_delta') {
      const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
      this.publishAssistantCommentDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'assistant_comment') {
      if (!this.assistantLiveDrafts.get(run.id)) {
        const draft = this.appendAssistantDraft(run.id, run.conversationId, event.content);
        this.publishAssistantCommentDelta(user.id, run.conversationId, run.id, event.content, draft.version);
      }
      await this.persistAssistantBoundary(user.id, run.conversationId, run.id, event.content);
      this.toolBoundaryMessageIds.delete(run.id);
      this.publishAssistantCommentDone(user.id, run.conversationId, run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent: '', assistantMessageWritten: false, done: false };
    }

    if (event.type === 'tool_round_start') {
      await this.persistToolRound(run, event);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_call_start') {
      if (assistantContent.trim()) {
        await this.persistAssistantBoundary(user.id, run.conversationId, run.id, assistantContent);
        assistantContent = '';
        this.toolBoundaryMessageIds.delete(run.id);
      }
      const assistantMessageId = await this.getOrCreateToolBoundaryMessage(run.conversationId, run.id);
      await this.recordToolCall({
        runId: run.id,
        conversationId: run.conversationId,
        assistantMessageId,
        toolCallId: event.id,
        toolName: event.name,
        toolArgs: event.arguments,
        status: 'running',
      });
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_result') {
      const clientAction = event.clientAction ?? getClientAction(event.result);
      const setupKind = getSetupInteractionKind(clientAction);
      if (clientAction && setupKind) {
        await this.persistAssistantBoundary(user.id, run.conversationId, run.id, assistantContent);
        await this.persistSetupInteraction(run, user.id, event, setupKind, clientAction);
        await this.updateRunStatus(run.id, 'waiting_for_setup');
        this.publishConversationChanged(user.id, run.conversationId);
        return { assistantContent: '', assistantMessageWritten: true, done: true };
      }
      await this.finishToolCall(
        run.id,
        event.id,
        event.name,
        event.result,
        event.error ?? null,
        event.rejected === true,
        event.resourceReferences ?? []
      );
      if (clientAction) this.publishClientAction?.(user.id, run.conversationId, run.id, clientAction);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'invalidate_stores') {
      this.publishConversationChanged(user.id, run.conversationId, event.stores);
      return { assistantContent, assistantMessageWritten, done: false };
    }

    if (event.type === 'tool_approval_required') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      await this.persistPendingInteraction(run, event, assistantMessageId);
      this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, run.conversationId);
      const roundId = event.roundId ?? (await this.findToolCallRoundId(run.id, event.id));
      if (!roundId) await this.setConversationCheckpoint(run.conversationId, event);
      await this.updateRunStatus(run.id, event.name === 'ask_question' ? 'waiting_for_answer' : 'waiting_for_approval');
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'credential_authorization_required') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      const challenge = await this.persistCredentialChallenge(run, user.id, event);
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      if (!challenge.roundId) await this.setConversationCheckpoint(run.conversationId, event);
      await this.updateRunStatus(run.id, 'waiting_for_credential');
      this.publishCredentialChallenge?.(user.id, run.conversationId, run.id, challenge);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'error' || event.type === 'context_blocked') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      if (event.type === 'context_blocked') {
        await this.persistConversationStatus(run.conversationId, 'context_blocked', event.reason);
      }
      const errorMessage = event.type === 'error' ? event.message : event.reason;
      await this.updateRunStatus(run.id, 'failed', errorMessage);
      await this.returnPendingSteersToQueue(run.id);
      if (event.type === 'error') {
        await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      }
      await this.notifyFailedRun(user, run, errorMessage);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    if (event.type === 'conversation_ended') {
      const assistantMessageId = await this.persistAssistantBoundary(
        user.id,
        run.conversationId,
        run.id,
        assistantContent
      );
      assistantMessageWritten = true;
      if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      await this.persistConversationStatus(run.conversationId, 'ended', event.reason);
    }

    if (event.type === 'done') {
      if (!assistantMessageWritten) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          run.conversationId,
          run.id,
          assistantContent,
          true
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      } else {
        await this.clearAssistantDraftState(run.id);
      }
      await this.updateRunStatus(run.id, 'completed');
      await this.setConversationCheckpoint(run.conversationId, null);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      let handledByPlan = false;
      if (this.handleCompletedRun) {
        try {
          handledByPlan = await this.handleCompletedRun(user, run);
        } catch (error) {
          logger.error('Failed to continue completed AI plan run', {
            runId: run.id,
            conversationId: run.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!handledByPlan) this.startPendingInputExecution(user, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    return { assistantContent, assistantMessageWritten, done: false };
  }

  private async notifyFailedRun(user: User, run: AIRun, error: string): Promise<void> {
    if (!this.handleFailedRun) return;
    try {
      await this.handleFailedRun(user, run, error);
    } catch (failureError) {
      logger.error('Failed to pause failed AI plan run', {
        runId: run.id,
        conversationId: run.conversationId,
        error: failureError instanceof Error ? failureError.message : String(failureError),
      });
    }
  }

  private async maybeAutoCompactContext(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    pageContext: ReturnType<typeof toPageContext>,
    abortController: AbortController
  ): Promise<ChatMessage[]> {
    if (run.planId && container.isRegistered(AIPlanService)) {
      const planService = container.resolve(AIPlanService);
      const plan = await planService.getActivePlanSnapshot(user.id, run.conversationId);
      if (plan?.id === run.planId && plan.status === 'pause_requested') {
        await planService.completePauseRequest(user.id, run.conversationId);
        this.publishConversationChanged(user.id, run.conversationId);
        throw new AppError(409, 'AI_PLAN_PAUSE_BOUNDARY', 'Plan paused at the tool-round boundary');
      }
    }
    const aiService = container.resolve(AIService);
    const shouldCompact = await aiService.shouldAutoCompactContext(
      user,
      messages,
      pageContext,
      run.conversationId,
      run.model ?? undefined,
      run.reasoningEffort ?? undefined
    );
    if (!shouldCompact) return messages;
    return this.performContextCompaction(user, run, messages, pageContext, abortController, 'auto', false);
  }

  private async receivePendingSteers(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    signal: AbortSignal
  ): Promise<ChatMessage[]> {
    let pending = await this.listPendingSteers(run.id);
    if (pending.length === 0 || signal.aborted) return messages;

    const firstSeenAt = Math.min(...pending.map((item) => item.updatedAt.getTime()));
    while (!signal.aborted) {
      const latestUpdateAt = Math.max(...pending.map((item) => item.updatedAt.getTime()));
      const wakeAt = Math.min(latestUpdateAt + STEER_DEBOUNCE_MS, firstSeenAt + STEER_MAX_WAIT_MS);
      const remaining = wakeAt - Date.now();
      if (remaining <= 0) break;
      await waitFor(Math.min(remaining, 200), signal);
      pending = await this.listPendingSteers(run.id);
      if (pending.length === 0) return messages;
    }
    if (signal.aborted) return messages;

    const consumed = await this.consumePendingSteers(user.id, run.conversationId, run.id);
    if (consumed.length === 0) return messages;
    this.publishConversationChanged(user.id, run.conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, run.conversationId);
    return [...messages, ...consumed];
  }

  private listPendingSteers(runId: string): Promise<AIConversationInput[]> {
    return this.db
      .select()
      .from(aiConversationInputs)
      .where(
        and(
          eq(aiConversationInputs.targetRunId, runId),
          eq(aiConversationInputs.mode, 'steer'),
          eq(aiConversationInputs.status, 'pending')
        )
      )
      .orderBy(asc(aiConversationInputs.createdAt));
  }

  private async returnPendingSteersToQueue(runId: string): Promise<void> {
    await this.db
      .update(aiConversationInputs)
      .set({ mode: 'queued', targetRunId: null, updatedAt: new Date() })
      .where(
        and(
          eq(aiConversationInputs.targetRunId, runId),
          eq(aiConversationInputs.mode, 'steer'),
          eq(aiConversationInputs.status, 'pending')
        )
      );
  }

  private async consumePendingSteers(userId: string, conversationId: string, runId: string): Promise<ChatMessage[]> {
    return this.db.transaction(async (tx) => {
      const pending = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.targetRunId, runId),
            eq(aiConversationInputs.mode, 'steer'),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .orderBy(asc(aiConversationInputs.createdAt));
      if (pending.length === 0) return [];

      let sequence = await nextMessageSequence(tx, conversationId);
      const values = pending.map((item) =>
        toConversationMessage(
          conversationId,
          {
            role: 'user',
            content: item.content,
            attachments: item.attachments,
            steer: true,
          },
          sequence++
        )
      );
      const inserted = await tx
        .insert(aiConversationMessages)
        .values(values)
        .returning({ id: aiConversationMessages.id, uiMessage: aiConversationMessages.uiMessage });
      const now = new Date();
      await tx
        .update(aiConversationInputs)
        .set({ status: 'consumed', consumedAt: now, updatedAt: now })
        .where(
          inArray(
            aiConversationInputs.id,
            pending.map((item) => item.id)
          )
        );
      await tx
        .update(aiConversations)
        .set({
          lastContext: pending.at(-1)?.context ?? undefined,
          updatedAt: now,
        })
        .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)));
      return inserted
        .map((row) => toChatMessage({ ...row.uiMessage, id: row.id }))
        .filter((message): message is ChatMessage => Boolean(message));
    });
  }

  private async dispatchNextPendingInput(user: User, conversationId: string): Promise<void> {
    const next = await this.db.transaction(async (tx) => {
      const [activeRun] = await tx
        .select({ id: aiRuns.id })
        .from(aiRuns)
        .where(and(eq(aiRuns.conversationId, conversationId), inArray(aiRuns.status, ACTIVE_RUN_STATUSES)))
        .limit(1);
      if (activeRun) return null;

      const pending = await tx
        .select()
        .from(aiConversationInputs)
        .where(
          and(
            eq(aiConversationInputs.conversationId, conversationId),
            eq(aiConversationInputs.userId, user.id),
            eq(aiConversationInputs.status, 'pending')
          )
        )
        .orderBy(asc(aiConversationInputs.createdAt));
      if (pending.length === 0) return null;

      const steerBatch = pending.filter((item) => item.mode === 'steer');
      const selected = steerBatch.length > 0 ? steerBatch : [pending[0]];
      const conversation = await getOwnedConversation(tx, user.id, conversationId);
      if (!conversation) return null;
      let sequence = await nextMessageSequence(tx, conversationId);
      const inserted = await tx
        .insert(aiConversationMessages)
        .values(
          selected.map((item) =>
            toConversationMessage(
              conversationId,
              {
                role: 'user',
                content: item.content,
                attachments: item.attachments,
                ...(item.mode === 'steer' ? { steer: true } : {}),
              },
              sequence++
            )
          )
        )
        .returning({ id: aiConversationMessages.id });
      const activeMessageId = inserted.at(-1)?.id;
      if (!activeMessageId) return null;
      const now = new Date();
      const [run] = await tx
        .insert(aiRuns)
        .values({
          conversationId,
          userId: user.id,
          clientCommandId: `input:${selected[0].id}`,
          activeMessageId,
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          status: 'queued',
          updatedAt: now,
        })
        .returning();
      await tx
        .update(aiConversationInputs)
        .set({ status: 'consumed', consumedAt: now, updatedAt: now })
        .where(
          inArray(
            aiConversationInputs.id,
            selected.map((item) => item.id)
          )
        );
      await tx
        .update(aiConversations)
        .set({ lastContext: selected.at(-1)?.context ?? conversation.lastContext, updatedAt: now })
        .where(eq(aiConversations.id, conversationId));
      return run;
    });
    if (!next) return;
    this.publishConversationChanged(user.id, conversationId);
    this.conversationSearchService?.rebuildConversationIndexBestEffort(user.id, conversationId);
    this.startRunExecution(user, next.id);
  }

  private async performContextCompaction(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    pageContext: ReturnType<typeof toPageContext>,
    abortController: AbortController,
    trigger: AIContextCompactionTrigger,
    allowNoopResult: boolean
  ): Promise<ChatMessage[]> {
    const toolCallId =
      trigger === 'auto' ? `${trigger}-compact-${run.id}-${Date.now()}` : `${trigger}-compact-${run.id}`;
    await this.recordToolCall({
      runId: run.id,
      conversationId: run.conversationId,
      toolCallId,
      toolName: 'compact_context',
      toolArgs: { trigger },
      status: 'running',
    });
    this.publishConversationChanged(user.id, run.conversationId);

    try {
      const result = await container
        .resolve(AIService)
        .compactConversationContext(
          user,
          messages,
          pageContext,
          abortController.signal,
          trigger,
          run.model ?? undefined,
          run.conversationId,
          run.reasoningEffort ?? undefined
        );
      if (result.compacted) {
        const markerMessageId = await this.persistCompactMarker(user.id, run.conversationId, result);
        await this.linkToolCallToAssistantMessage(run.id, toolCallId, markerMessageId);
      }
      await this.finishToolCall(run.id, toolCallId, 'compact_context', result, null);
      this.publishConversationChanged(user.id, run.conversationId);
      if (!result.compacted && !allowNoopResult) return messages;
      if (!result.compacted) return this.loadConversationMessages(run.conversationId);
      return compactedRuntimeMessages(messages, result);
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      await this.finishToolCall(
        run.id,
        toolCallId,
        'compact_context',
        undefined,
        error instanceof Error ? error.message : 'Context compaction failed'
      );
      this.publishConversationChanged(user.id, run.conversationId);
      throw error;
    }
  }

  private async getOwnedRun(userId: string, runId: string): Promise<AIRun | null> {
    const rows = await this.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  private async loadConversationMessages(
    conversationId: string,
    options: { includeHistoricalToolOutcomes?: boolean } = {}
  ): Promise<ChatMessage[]> {
    const rows = await this.db
      .select({ id: aiConversationMessages.id, uiMessage: aiConversationMessages.uiMessage })
      .from(aiConversationMessages)
      .where(eq(aiConversationMessages.conversationId, conversationId))
      .orderBy(asc(aiConversationMessages.sequence));

    const compactMarkerIndex = findLastCompactMarkerIndex(rows.map((row) => row.uiMessage));
    const activeRows = compactMarkerIndex >= 0 ? rowsForCompactMarkerBoundary(rows, compactMarkerIndex) : rows;
    const messages: Array<{ id: string | null; message: ChatMessage }> = [];
    for (const row of activeRows) {
      const message = toChatMessage(row.uiMessage);
      if (message) messages.push({ id: row.id, message: { ...message, id: row.id } });
    }

    if (!options.includeHistoricalToolOutcomes) return messages.map((entry) => entry.message);
    return this.appendHistoricalToolOutcomes(conversationId, messages);
  }

  private async persistAssistantMessageIfNeeded(
    userId: string,
    conversationId: string,
    runId: string,
    content: string,
    includeChangedResources = false
  ): Promise<string | null> {
    if (!content.trim() && !includeChangedResources) return null;
    const messageReferences = await this.resolveMessageResourceReferences(
      conversationId,
      runId,
      content,
      includeChangedResources
    );
    if (!content.trim() && messageReferences.changed.length === 0) return null;
    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'assistant',
            content,
            ...(messageReferences.referenced.length > 0 ? { resourceReferences: messageReferences.referenced } : {}),
            ...(messageReferences.changed.length > 0 ? { changedResourceReferences: messageReferences.changed } : {}),
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
    return message?.id ?? null;
  }

  private async persistRunErrorMessage(
    userId: string,
    conversationId: string,
    runId: string,
    error: string
  ): Promise<void> {
    const content = `**Error:** ${error.trim() || 'AI run failed'}`;
    const sequence = await nextMessageSequence(this.db, conversationId);
    await this.db.insert(aiConversationMessages).values(
      toConversationMessage(
        conversationId,
        {
          role: 'assistant',
          content,
          localOnly: true,
          runError: true,
          runId,
        },
        sequence
      )
    );
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
  }

  private async getOrCreateToolBoundaryMessage(conversationId: string, runId: string): Promise<string> {
    const existing = this.toolBoundaryMessageIds.get(runId);
    if (existing) return existing;

    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'assistant',
            content: '',
            toolGroupBoundary: true,
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });

    if (!message?.id) {
      throw new AppError(500, 'AI_TOOL_BOUNDARY_NOT_CREATED', 'AI tool call boundary was not created');
    }

    this.toolBoundaryMessageIds.set(runId, message.id);
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
    return message.id;
  }

  private appendAssistantDraft(runId: string, conversationId: string, delta: string): AssistantLiveDraft {
    return this.assistantLiveDrafts.append(runId, conversationId, delta);
  }

  private async persistAssistantBoundary(
    userId: string,
    conversationId: string,
    runId: string,
    fallbackContent: string,
    includeChangedResources = false
  ): Promise<string | null> {
    const content = this.assistantLiveDrafts.getContent(runId, fallbackContent);
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(
      userId,
      conversationId,
      runId,
      content,
      includeChangedResources
    );
    await this.clearAssistantDraftState(runId);
    return assistantMessageId;
  }

  private async persistConversationStatus(
    conversationId: string,
    status: 'ended' | 'context_blocked',
    reason: string
  ): Promise<void> {
    const sequence = await nextMessageSequence(this.db, conversationId);
    await this.db.insert(aiConversationMessages).values(
      toConversationMessage(
        conversationId,
        {
          role: 'assistant',
          content: '',
          conversationStatus: status,
          blockReason: reason,
        },
        sequence
      )
    );
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
  }

  private async persistCompactMarker(
    userId: string,
    conversationId: string,
    result: AIContextCompactionResult
  ): Promise<string> {
    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'system',
            content: compactLifecycleContent(result),
            hiddenSystemEvent: true,
            lifecycleEvent: { type: 'context_compacted', trigger: result.trigger },
            compactMarker: true,
            compactVersion: 2,
            compactEpoch: result.compactEpoch,
            compactBoundaryMessageId: result.compactBoundaryMessageId,
            compactedAt: new Date().toISOString(),
            compactedMessageCount: result.compactedMessageCount,
            sourceTokenEstimate: result.sourceTokenEstimate,
            resultTokenEstimate: result.resultTokenEstimate,
            compactTrigger: result.trigger === 'auto' ? 'automatic' : 'manual',
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });
    await this.db
      .update(aiConversations)
      .set({ discoveredToolsets: [], updatedAt: new Date() })
      .where(eq(aiConversations.id, conversationId));
    this.conversationSearchService?.rebuildConversationIndexBestEffort(userId, conversationId);
    if (!message?.id)
      throw new AppError(500, 'AI_COMPACT_MARKER_NOT_CREATED', 'Context compact marker was not created');
    return message.id;
  }

  private async clearAssistantDraftState(runId: string): Promise<void> {
    this.assistantLiveDrafts.clearContent(runId);
    await this.clearAssistantDraft(runId);
  }

  private forgetAssistantDraftState(runId: string): void {
    this.assistantLiveDrafts.forget(runId);
  }

  private async recordToolCall(input: {
    runId: string;
    conversationId: string;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    assistantMessageId?: string | null;
    status: 'running' | 'pending_approval';
  }): Promise<void> {
    await this.db
      .insert(aiRunToolCalls)
      .values({
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId ?? null,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        classification: classifyAIToolForApproval(input.toolName, input.toolArgs),
        approvalPolicy: input.status === 'pending_approval' ? 'requires_approval' : 'auto_approved',
        requiredScopes: [],
        status: input.status,
      })
      .onConflictDoUpdate({
        target: [aiRunToolCalls.runId, aiRunToolCalls.toolCallId],
        set: {
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
          classification: classifyAIToolForApproval(input.toolName, input.toolArgs),
          approvalPolicy: input.status === 'pending_approval' ? 'requires_approval' : 'auto_approved',
          status: input.status,
          updatedAt: new Date(),
        },
      });
  }

  private async persistToolRound(
    run: AIRun,
    event: Extract<WSServerMessage, { type: 'tool_round_start' }>
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ sequence: aiRunToolRounds.sequence })
        .from(aiRunToolRounds)
        .where(eq(aiRunToolRounds.runId, run.id))
        .orderBy(desc(aiRunToolRounds.sequence))
        .limit(1);
      const hasQuestions = event.calls.some((call) => call.gate === 'question');
      const hasApprovals = event.calls.some((call) => call.gate === 'approval');
      await tx.insert(aiRunToolRounds).values({
        id: event.roundId,
        runId: run.id,
        conversationId: run.conversationId,
        sequence: (latest?.sequence ?? -1) + 1,
        status: hasQuestions ? 'waiting_questions' : hasApprovals ? 'waiting_approvals' : 'executing',
        providerMessages: event.providerMessages,
        startedAt: hasQuestions || hasApprovals ? null : new Date(),
      });
      if (event.calls.length > 0) {
        await tx.insert(aiRunToolCalls).values(
          event.calls.map((call) => ({
            runId: run.id,
            roundId: event.roundId,
            position: call.position,
            conversationId: run.conversationId,
            toolCallId: call.id,
            toolName: call.name,
            toolArgs: call.arguments,
            classification: call.classification,
            approvalPolicy: call.approvalPolicy,
            requiredScopes: call.requiredScopes,
            status: call.gate === 'approval' ? ('pending_approval' as const) : ('created' as const),
          }))
        );
      }
      const questions = event.calls.filter((call) => call.gate === 'question');
      if (questions.length > 0) {
        await tx.insert(aiRunQuestions).values(
          questions.map((call) => ({
            runId: run.id,
            roundId: event.roundId,
            position: call.position,
            conversationId: run.conversationId,
            toolCallId: call.id,
            question: questionTextFromArgs(call.arguments),
          }))
        );
      }
    });
  }

  private async finishToolCall(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    error: string | null,
    rejected = false,
    resourceReferences: AIResourceReference[] = []
  ): Promise<void> {
    const now = new Date();
    const persistedResult = redactOneTimeSecretToolResult(toolName, result);
    await this.db
      .update(aiRunToolCalls)
      .set({
        status: rejected ? 'rejected' : error ? 'failed' : 'completed',
        result: persistedResult,
        resourceReferences,
        error,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)));
    await this.updateToolRoundProgress(
      runId,
      toolCallId,
      error ? { error } : appendAIResourceReferencesToModelResult(persistedResult, resourceReferences)
    );
  }

  private async resolveMessageResourceReferences(
    conversationId: string,
    runId: string,
    content: string,
    includeChangedResources: boolean
  ): Promise<{ referenced: AIResourceReference[]; changed: AIResourceReference[] }> {
    const referencedIds = new Set(referencedAIResourceIds(content));
    if (referencedIds.size === 0 && !includeChangedResources) {
      return { referenced: [], changed: [] };
    }
    const rows = await this.db
      .select({
        runId: aiRunToolCalls.runId,
        status: aiRunToolCalls.status,
        resourceReferences: aiRunToolCalls.resourceReferences,
      })
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.conversationId, conversationId))
      .orderBy(asc(aiRunToolCalls.createdAt));
    const registry = new Map<string, AIResourceReference>();
    const changed = new Map<string, AIResourceReference>();
    const changedNodeIds = new Set<string>();
    for (const row of rows) {
      if (row.status !== 'completed') continue;
      for (const reference of row.resourceReferences ?? []) {
        const resolvedReference = mergeAIResourceReference(registry.get(reference.refId), reference);
        registry.set(reference.refId, resolvedReference);
        if (
          includeChangedResources &&
          row.runId === runId &&
          (reference.relation === 'created' || reference.relation === 'updated' || reference.relation === 'deleted')
        ) {
          changed.set(reference.refId, mergeAIResourceReference(changed.get(reference.refId), resolvedReference));
          if (reference.nodeId) changedNodeIds.add(reference.nodeId);
        }
      }
    }
    if (includeChangedResources && changedNodeIds.size > 0) {
      for (const reference of registry.values()) {
        if (reference.type === 'node' && changedNodeIds.has(reference.resourceId)) {
          changed.set(reference.refId, reference);
        }
      }
    }
    const referenced = [...referencedIds]
      .map((refId) => registry.get(refId))
      .filter((reference): reference is AIResourceReference => Boolean(reference));
    for (const refId of referencedIds) changed.delete(refId);
    return { referenced, changed: [...changed.values()] };
  }

  private async updateToolRoundProgress(runId: string, toolCallId: string, modelResult: unknown): Promise<void> {
    const [current] = await this.db
      .select({ roundId: aiRunToolCalls.roundId })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)))
      .limit(1);
    if (!current?.roundId) return;
    const [round] = await this.db
      .select({ providerMessages: aiRunToolRounds.providerMessages })
      .from(aiRunToolRounds)
      .where(eq(aiRunToolRounds.id, current.roundId))
      .limit(1);
    if (round) {
      const alreadyRecorded = round.providerMessages.some(
        (message) => message.role === 'tool' && message.tool_call_id === toolCallId
      );
      if (!alreadyRecorded) {
        await this.db
          .update(aiRunToolRounds)
          .set({
            providerMessages: [
              ...round.providerMessages,
              { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(modelResult ?? null) },
            ],
            updatedAt: new Date(),
          })
          .where(eq(aiRunToolRounds.id, current.roundId));
      }
    }
    const calls = await this.db
      .select({ status: aiRunToolCalls.status })
      .from(aiRunToolCalls)
      .where(eq(aiRunToolCalls.roundId, current.roundId));
    const terminal = new Set(['completed', 'failed', 'rejected', 'stopped', 'effect_unknown']);
    if (!calls.length || calls.some((call) => !terminal.has(call.status))) return;
    const status = calls.some((call) => call.status === 'stopped')
      ? 'stopped'
      : calls.some((call) => call.status === 'failed' || call.status === 'effect_unknown')
        ? 'failed'
        : 'completed';
    const now = new Date();
    await this.db
      .update(aiRunToolRounds)
      .set({ status, completedAt: now, updatedAt: now })
      .where(eq(aiRunToolRounds.id, current.roundId));
  }

  private async persistPendingInteraction(
    run: AIRun,
    event: Extract<WSServerMessage, { type: 'tool_approval_required' }>,
    assistantMessageId: string | null
  ): Promise<void> {
    if (event.name === 'ask_question') {
      const questions = getQuestionBatch(event);
      await this.db
        .insert(aiRunQuestions)
        .values(
          questions.map((question) => ({
            runId: run.id,
            conversationId: run.conversationId,
            toolCallId: question.id,
            question: questionTextFromArgs(question.args),
          }))
        )
        .onConflictDoNothing({ target: [aiRunQuestions.runId, aiRunQuestions.toolCallId] });
      return;
    }

    await this.recordToolCall({
      runId: run.id,
      conversationId: run.conversationId,
      assistantMessageId,
      toolCallId: event.id,
      toolName: event.name,
      toolArgs: event.arguments,
      status: 'pending_approval',
    });
  }

  private async persistCredentialChallenge(
    run: AIRun,
    userId: string,
    event: Extract<WSServerMessage, { type: 'credential_authorization_required' }>
  ): Promise<AICredentialChallenge> {
    const roundId = event.roundId ?? (await this.findToolCallRoundId(run.id, event.id));
    const [challenge] = await this.db
      .insert(aiRunCredentialChallenges)
      .values({
        runId: run.id,
        roundId,
        conversationId: run.conversationId,
        userId,
        provider: event.provider,
        connectorId: event.connectorId,
        toolCallId: event.id,
        toolName: event.name,
      })
      .onConflictDoUpdate({
        target: [aiRunCredentialChallenges.runId, aiRunCredentialChallenges.toolCallId],
        set: {
          connectorId: event.connectorId,
          toolName: event.name,
          roundId,
          status: 'pending',
          decisionClientCommandId: null,
          resolvedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!challenge) throw new Error('Failed to persist AI credential challenge');
    return challenge;
  }

  private async persistSetupInteraction(
    run: AIRun,
    userId: string,
    event: Extract<WSServerMessage, { type: 'tool_result' }>,
    kind: AISetupInteraction['kind'],
    payload: Record<string, unknown>
  ): Promise<AISetupInteraction> {
    const roundId = await this.findToolCallRoundId(run.id, event.id);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const [interaction] = await this.db
      .insert(aiRunSetupInteractions)
      .values({
        runId: run.id,
        roundId,
        conversationId: run.conversationId,
        userId,
        toolCallId: event.id,
        toolName: event.name,
        kind,
        payload,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [aiRunSetupInteractions.runId, aiRunSetupInteractions.toolCallId],
        set: {
          roundId,
          kind,
          payload,
          status: 'pending',
          result: null,
          resolvedByUserId: null,
          resolveClientCommandId: null,
          expiresAt,
          resolvedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!interaction) throw new Error('Failed to persist AI setup interaction');
    if (roundId) {
      await this.db
        .update(aiRunToolRounds)
        .set({ status: 'waiting_setup', updatedAt: new Date() })
        .where(eq(aiRunToolRounds.id, roundId));
    }
    return interaction;
  }

  private async findToolCallRoundId(runId: string, toolCallId: string): Promise<string | null> {
    const [toolCall] = await this.db
      .select({ roundId: aiRunToolCalls.roundId })
      .from(aiRunToolCalls)
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)))
      .limit(1);
    return toolCall?.roundId ?? null;
  }

  private async setConversationCheckpoint(conversationId: string, event: WSServerMessage | null): Promise<void> {
    await this.db
      .update(aiConversations)
      .set({
        checkpoint: event ? toCheckpoint(event) : null,
        updatedAt: new Date(),
      })
      .where(eq(aiConversations.id, conversationId));
  }

  private async clearAssistantDraft(runId: string): Promise<void> {
    await this.db
      .update(aiRuns)
      .set({ assistantDraftContent: null, updatedAt: new Date() })
      .where(eq(aiRuns.id, runId));
  }

  private async linkRunToolCallsToAssistantMessage(runId: string, assistantMessageId: string): Promise<void> {
    await this.db
      .update(aiRunToolCalls)
      .set({ assistantMessageId, updatedAt: new Date() })
      .where(and(eq(aiRunToolCalls.runId, runId), isNull(aiRunToolCalls.assistantMessageId)));
  }

  private async linkToolCallToAssistantMessage(
    runId: string,
    toolCallId: string,
    assistantMessageId: string
  ): Promise<void> {
    await this.db
      .update(aiRunToolCalls)
      .set({ assistantMessageId, updatedAt: new Date() })
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)));
  }

  private async appendHistoricalToolOutcomes(
    conversationId: string,
    entries: Array<{ id: string | null; message: ChatMessage }>
  ): Promise<ChatMessage[]> {
    const assistantMessageIds = entries
      .filter((entry) => entry.id && entry.message.role === 'assistant')
      .map((entry) => entry.id as string);
    if (assistantMessageIds.length === 0) return entries.map((entry) => entry.message);

    const toolCalls = await this.db
      .select({
        assistantMessageId: aiRunToolCalls.assistantMessageId,
        toolName: aiRunToolCalls.toolName,
        status: aiRunToolCalls.status,
        decision: aiRunToolCalls.decision,
        result: aiRunToolCalls.result,
        resourceReferences: aiRunToolCalls.resourceReferences,
        error: aiRunToolCalls.error,
      })
      .from(aiRunToolCalls)
      .where(
        and(
          eq(aiRunToolCalls.conversationId, conversationId),
          inArray(aiRunToolCalls.assistantMessageId, assistantMessageIds)
        )
      )
      .orderBy(asc(aiRunToolCalls.createdAt));

    const summariesByMessageId = new Map<string, string[]>();
    for (const toolCall of toolCalls) {
      if (!toolCall.assistantMessageId) continue;
      const summaries = summariesByMessageId.get(toolCall.assistantMessageId) ?? [];
      summaries.push(formatHistoricalToolOutcome(toolCall));
      summariesByMessageId.set(toolCall.assistantMessageId, summaries);
    }

    return entries.map((entry) => {
      if (!entry.id || entry.message.role !== 'assistant') return entry.message;
      const summaries = summariesByMessageId.get(entry.id);
      if (!summaries?.length) return entry.message;
      return {
        ...entry.message,
        content: `${entry.message.content}\n\n[Historical tool outcomes]\n${summaries.join('\n')}`,
      };
    });
  }

  private async listAnsweredQuestions(runId: string): Promise<AIRunQuestion[]> {
    return this.db
      .select()
      .from(aiRunQuestions)
      .where(and(eq(aiRunQuestions.runId, runId), eq(aiRunQuestions.status, 'answered')))
      .orderBy(asc(aiRunQuestions.createdAt));
  }

  private async loadCheckpoint(userId: string, conversationId: string) {
    const conversation = await getOwnedConversation(this.db, userId, conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
    return normalizeCheckpoint(conversation.checkpoint);
  }

  private async updateRunStatus(runId: string, status: AIRun['status'], error?: string | null): Promise<void> {
    const now = new Date();
    const terminal =
      status === 'completed'
        ? { completedAt: now, stoppedAt: null }
        : status === 'stopped'
          ? { completedAt: null, stoppedAt: now }
          : { completedAt: null, stoppedAt: null };
    await this.db
      .update(aiRuns)
      .set({
        status,
        error: error ?? null,
        updatedAt: now,
        startedAt: status === 'running' ? now : undefined,
        ...(status === 'running' ? {} : { leaseOwner: null, leaseExpiresAt: null }),
        ...terminal,
      })
      .where(this.fencedRunWhere(runId));
  }

  private async claimRun(run: AIRun, allowedStatuses: AIRun['status'][]): Promise<boolean> {
    const now = new Date();
    const epoch = (run.executionEpoch ?? 0) + 1;
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const query = this.db
      .update(aiRuns)
      .set({
        status: 'running',
        executionEpoch: sql`${aiRuns.executionEpoch} + 1`,
        leaseOwner: this.leaseOwner,
        leaseExpiresAt,
        startedAt: run.startedAt ?? now,
        completedAt: null,
        stoppedAt: null,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(aiRuns.id, run.id),
          eq(aiRuns.userId, run.userId),
          eq(aiRuns.executionEpoch, run.executionEpoch ?? 0),
          inArray(aiRuns.status, allowedStatuses),
          or(isNull(aiRuns.leaseExpiresAt), lt(aiRuns.leaseExpiresAt, now), eq(aiRuns.leaseOwner, this.leaseOwner))
        )
      );
    const returning = (query as unknown as { returning?: () => Promise<Array<{ id: string }>> }).returning;
    if (typeof returning === 'function') {
      const claimed = await returning.call(query);
      if (claimed.length === 0) return false;
    } else {
      await query;
    }
    this.executionEpochs.set(run.id, epoch);
    this.startHeartbeat(run.id, epoch);
    return true;
  }

  private startHeartbeat(runId: string, epoch: number): void {
    this.stopHeartbeat(runId);
    const timer = setInterval(() => {
      void this.db
        .update(aiRuns)
        .set({ leaseExpiresAt: new Date(Date.now() + 30_000), updatedAt: new Date() })
        .where(
          and(
            eq(aiRuns.id, runId),
            eq(aiRuns.executionEpoch, epoch),
            eq(aiRuns.leaseOwner, this.leaseOwner),
            eq(aiRuns.status, 'running')
          )
        );
    }, 10_000);
    timer.unref?.();
    this.heartbeatTimers.set(runId, timer);
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(runId);
  }

  private async releaseLease(runId: string): Promise<void> {
    this.stopHeartbeat(runId);
    const epoch = this.executionEpochs.get(runId);
    this.executionEpochs.delete(runId);
    if (epoch === undefined) return;
    await this.db
      .update(aiRuns)
      .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(aiRuns.id, runId), eq(aiRuns.executionEpoch, epoch), eq(aiRuns.leaseOwner, this.leaseOwner)));
  }

  private fencedRunWhere(runId: string) {
    const epoch = this.executionEpochs.get(runId);
    return epoch === undefined
      ? eq(aiRuns.id, runId)
      : and(eq(aiRuns.id, runId), eq(aiRuns.executionEpoch, epoch), eq(aiRuns.leaseOwner, this.leaseOwner));
  }

  private logExecutionError(runId: string, error: unknown): void {
    logger.error('AI run execution failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isPlanPauseBoundaryError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'AI_PLAN_PAUSE_BOUNDARY';
}

type DbLike = Pick<DrizzleClient, 'select' | 'insert' | 'update'>;

function findLastCompactMarkerIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).compactMarker === true
    ) {
      return i;
    }
  }
  return -1;
}

function rowsForCompactMarkerBoundary<T extends { id?: string | null; uiMessage: Record<string, unknown> }>(
  rows: T[],
  markerIndex: number
): T[] {
  const marker = rows[markerIndex];
  if (marker.uiMessage.compactVersion === 2 && typeof marker.uiMessage.compactBoundaryMessageId === 'string') {
    const boundaryIndex = rows.findIndex((row) => row.id === marker.uiMessage.compactBoundaryMessageId);
    if (boundaryIndex >= 0 && boundaryIndex < markerIndex) {
      return [marker, ...rows.slice(boundaryIndex + 1, markerIndex), ...rows.slice(markerIndex + 1)];
    }
  }
  const tailCount =
    typeof marker.uiMessage.compactTailMessageCount === 'number' &&
    Number.isFinite(marker.uiMessage.compactTailMessageCount)
      ? Math.max(0, Math.trunc(marker.uiMessage.compactTailMessageCount))
      : 0;
  const tailStart = Math.max(0, markerIndex - tailCount);
  return [marker, ...rows.slice(tailStart, markerIndex), ...rows.slice(markerIndex + 1)];
}

function compactedRuntimeMessages(messages: ChatMessage[], result: AIContextCompactionResult): ChatMessage[] {
  const boundaryIndex = messages.findIndex((message) => message.id === result.compactBoundaryMessageId);
  if (boundaryIndex < 0) {
    throw new AppError(
      409,
      'AI_COMPACTION_BOUNDARY_UNKNOWN',
      'The compacted message boundary is no longer present in runtime context'
    );
  }
  return [
    {
      role: 'system',
      content: compactLifecycleContent(result),
      hiddenSystemEvent: true,
      lifecycleEvent: { type: 'context_compacted', trigger: result.trigger },
      compactMarker: true,
      compactVersion: 2,
      compactEpoch: result.compactEpoch,
      compactBoundaryMessageId: result.compactBoundaryMessageId ?? undefined,
    },
    ...messages.slice(boundaryIndex + 1),
  ];
}

function compactLifecycleContent(result: AIContextCompactionResult): string {
  return [
    `Context compaction occurred (${result.trigger}).`,
    'The summary below is lossy. If an exact older detail is needed, use search_compacted_history rather than guessing.',
    '',
    'Compacted summary:',
    result.summary,
  ].join('\n');
}

function formatHistoricalToolOutcome(toolCall: {
  toolName: string;
  status: string;
  decision: string | null;
  result: unknown;
  resourceReferences: AIResourceReference[];
  error: string | null;
}): string {
  const parts = [`${toolCall.toolName} status=${toolCall.status}`];
  if (toolCall.decision) parts.push(`decision=${toolCall.decision}`);
  if (toolCall.error) {
    parts.push(`error=${safeInlineText(toolCall.error)}`);
  } else if (toolCall.result !== null && toolCall.result !== undefined) {
    const redactedResult = redactOneTimeSecretToolResult(toolCall.toolName, toolCall.result);
    parts.push(`result=${safeJson(redactedResult)}`);
  }
  if (toolCall.resourceReferences.length > 0) {
    parts.push(
      `resources=${toolCall.resourceReferences.map((reference) => formatAIResourceMarker(reference)).join(',')}`
    );
  }
  return `- ${parts.join(' ')}`;
}

function safeJson(value: unknown): string {
  try {
    return safeInlineText(JSON.stringify(value));
  } catch {
    return safeInlineText(String(value));
  }
}

function safeInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function getOwnedConversation(db: DbLike, userId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
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

function estimateJsonSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function getQuestionBatch(
  event: Extract<WSServerMessage, { type: 'tool_approval_required' }>
): Array<{ id: string; args: Record<string, unknown> }> {
  const payload = event as typeof event & { _allQuestions?: unknown };
  if (Array.isArray(payload._allQuestions)) {
    const questions = payload._allQuestions
      .map((question) => {
        if (!question || typeof question !== 'object') return null;
        const record = question as Record<string, unknown>;
        if (typeof record.id !== 'string') return null;
        const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args) ? record.args : {};
        return { id: record.id, args: args as Record<string, unknown> };
      })
      .filter((question): question is { id: string; args: Record<string, unknown> } => question !== null);
    if (questions.length > 0) return questions;
  }

  return [{ id: event.id, args: event.arguments }];
}
