import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { container } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import {
  type AICredentialChallenge,
  type AIRun,
  type AIRunQuestion,
  type AIRunToolCall,
  aiConversationMessages,
  aiConversations,
  aiRunCredentialChallenges,
  aiRunQuestions,
  aiRuns,
  aiRunToolCalls,
} from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { type AIContextCompactionResult, type AIContextCompactionTrigger, AIService } from './ai.service.js';
import type { ChatMessage, WSServerMessage } from './ai.types.js';
import { classifyAIToolForApproval } from './ai-approval-policy.js';
import type { AIConversationSearchService } from './ai-conversation-search.service.js';
import { type AssistantLiveDraft, AssistantLiveDraftStore } from './ai-live-draft-store.js';
import {
  normalizeCheckpoint,
  questionTextFromArgs,
  toChatMessage,
  toCheckpoint,
  toPageContext,
} from './ai-run-runtime.helpers.js';
import { redactOneTimeSecretToolResult } from './ai-secret-result-redaction.js';

const logger = createChildLogger('AI-Run-Executor');
const COMPACTION_TAIL_MESSAGES = 8;
const AUTO_COMPACTION_RETRY_PREFIX = 'auto-compact-retry-';
const AUTO_COMPACTION_RETRY_ANSWER = 'Retry';

function getClientAction(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const action = (result as { clientAction?: unknown }).clientAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action as Record<string, unknown>;
}

class AutoCompactionPausedError extends Error {
  constructor() {
    super('Automatic context compaction is waiting for retry');
    this.name = 'AutoCompactionPausedError';
  }
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
  rejectionError?: string;
}

export class AIRunExecutor {
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly executingRuns = new Set<string>();
  private readonly assistantLiveDrafts = new AssistantLiveDraftStore();
  private readonly toolBoundaryMessageIds = new Map<string, string>();

  constructor(
    private readonly db: DrizzleClient,
    private readonly publishConversationChanged: PublishConversationChanged,
    private readonly publishAssistantDelta: PublishAssistantDelta,
    private readonly publishAssistantCommentDelta: PublishAssistantCommentDelta,
    private readonly publishAssistantCommentDone: PublishAssistantCommentDone,
    private readonly conversationSearchService?: AIConversationSearchService,
    private readonly publishCredentialChallenge?: PublishCredentialChallenge,
    private readonly publishClientAction?: PublishClientAction
  ) {}

  startRunExecution(user: User, runId: string): void {
    if (this.executingRuns.has(runId)) return;
    this.executingRuns.add(runId);
    void this.executeRun(user, runId).catch((error) => {
      this.logExecutionError(runId, error);
    });
  }

  startApprovalContinuation(user: User, input: ApprovalContinuationInput): void {
    if (this.executingRuns.has(input.runId)) return;
    this.executingRuns.add(input.runId);
    void this.executeApprovalContinuation(user, input).catch((error) => {
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
  }

  async waitForIdle(deadline: number): Promise<void> {
    while (this.executingRuns.size > 0 && Date.now() < deadline) {
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
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(userId, conversationId, content);
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

    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    await this.updateRunStatus(run.id, 'running');
    this.publishConversationChanged(user.id, run.conversationId);

    const pageContext = toPageContext(conversation.lastContext);
    const aiService = container.resolve(AIService);
    const messages = await this.loadConversationMessages(run.conversationId, {
      includeHistoricalToolOutcomes: true,
    });
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
        run.reasoningEffort ?? undefined
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
      if (error instanceof AutoCompactionPausedError) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          run.conversationId,
          run.id,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
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
      await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
    } finally {
      this.abortControllers.delete(run.id);
      this.executingRuns.delete(run.id);
      this.toolBoundaryMessageIds.delete(run.id);
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
    if (firstQuestion.args._compactionRetry === true) {
      await this.finishToolCall(
        input.runId,
        input.question.toolCallId,
        'ask_question',
        {
          answer: input.question.answer ?? AUTO_COMPACTION_RETRY_ANSWER,
        },
        null
      );
      await this.executeAutoCompactionRetry(user, {
        conversationId: input.conversationId,
        runId: input.runId,
        pendingMessages: checkpoint.pendingMessages,
      });
      return;
    }
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
    await this.executeResume(user, {
      conversationId: input.conversationId,
      runId: input.runId,
      toolCallId: pending.id,
      toolName: pending.name,
      toolArgs: pending.arguments,
      approved: input.authorized,
      pendingMessages: checkpoint.pendingMessages,
      queuedApprovals: checkpoint.queuedApprovals,
      rejectionError: input.authorized
        ? undefined
        : 'GITLAB_AUTHORIZATION_REJECTED: User rejected GitLab authorization.',
    });
  }

  private async executeResume(user: User, input: ResumeInput): Promise<void> {
    const run = await this.getOwnedRun(user.id, input.runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (
      run.status !== 'waiting_for_approval' &&
      run.status !== 'waiting_for_answer' &&
      run.status !== 'waiting_for_credential'
    ) {
      return;
    }

    const conversation = await getOwnedConversation(this.db, user.id, input.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    const abortController = new AbortController();
    this.abortControllers.set(input.runId, abortController);
    await this.updateRunStatus(input.runId, 'running');
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
        run.reasoningEffort ?? undefined
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
      if (error instanceof AutoCompactionPausedError) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          input.conversationId,
          input.runId,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
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
      await this.persistRunErrorMessage(user.id, input.conversationId, input.runId, errorMessage);
      this.forgetAssistantDraftState(input.runId);
      this.publishConversationChanged(user.id, input.conversationId);
    } finally {
      this.abortControllers.delete(input.runId);
      this.executingRuns.delete(input.runId);
      this.toolBoundaryMessageIds.delete(input.runId);
    }
  }

  private async executeAutoCompactionRetry(
    user: User,
    input: { conversationId: string; runId: string; pendingMessages: Record<string, unknown>[] }
  ): Promise<void> {
    const run = await this.getOwnedRun(user.id, input.runId);
    if (!run) throw new AppError(404, 'AI_RUN_NOT_FOUND', 'AI run not found');
    if (run.status !== 'waiting_for_answer') return;

    const conversation = await getOwnedConversation(this.db, user.id, input.conversationId);
    if (!conversation) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');

    const abortController = new AbortController();
    this.abortControllers.set(input.runId, abortController);
    await this.updateRunStatus(input.runId, 'running');
    this.publishConversationChanged(user.id, input.conversationId);

    const aiService = container.resolve(AIService);
    const pageContext = toPageContext(conversation.lastContext);
    const messages = input.pendingMessages
      .map(toChatMessage)
      .filter((message): message is ChatMessage => message !== null && message.role !== 'system');
    let assistantContent = '';
    let assistantMessageWritten = false;

    try {
      for await (const event of aiService.streamChat(
        user,
        messages,
        pageContext,
        abortController.signal,
        input.runId,
        input.conversationId,
        (currentMessages) => this.maybeAutoCompactContext(user, run, currentMessages, pageContext, abortController),
        run.model ?? undefined,
        run.reasoningEffort ?? undefined
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
      if (error instanceof AutoCompactionPausedError) {
        const assistantMessageId = await this.persistAssistantBoundary(
          user.id,
          input.conversationId,
          input.runId,
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(input.runId, assistantMessageId);
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
      await this.persistRunErrorMessage(user.id, input.conversationId, input.runId, errorMessage);
      this.forgetAssistantDraftState(input.runId);
      this.publishConversationChanged(user.id, input.conversationId);
    } finally {
      this.abortControllers.delete(input.runId);
      this.executingRuns.delete(input.runId);
      this.toolBoundaryMessageIds.delete(input.runId);
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

    const abortController = new AbortController();
    this.abortControllers.set(run.id, abortController);
    await this.updateRunStatus(run.id, 'running');
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
      await this.finishToolCall(run.id, event.id, event.name, event.result, event.error ?? null);
      const clientAction = getClientAction(event.result);
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
      await this.setConversationCheckpoint(run.conversationId, event);
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
      await this.setConversationCheckpoint(run.conversationId, event);
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
      if (event.type === 'error') {
        await this.persistRunErrorMessage(user.id, run.conversationId, run.id, errorMessage);
      }
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
          assistantContent
        );
        if (assistantMessageId) await this.linkRunToolCallsToAssistantMessage(run.id, assistantMessageId);
      } else {
        await this.clearAssistantDraftState(run.id);
      }
      await this.updateRunStatus(run.id, 'completed');
      await this.setConversationCheckpoint(run.conversationId, null);
      this.forgetAssistantDraftState(run.id);
      this.publishConversationChanged(user.id, run.conversationId);
      return { assistantContent, assistantMessageWritten, done: true };
    }

    return { assistantContent, assistantMessageWritten, done: false };
  }

  private async maybeAutoCompactContext(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    pageContext: ReturnType<typeof toPageContext>,
    abortController: AbortController
  ): Promise<ChatMessage[]> {
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
    try {
      return await this.performContextCompaction(user, run, messages, pageContext, abortController, 'auto', false);
    } catch (error) {
      if (abortController.signal.aborted) throw error;
      await this.pauseForAutoCompactionRetry(user, run, messages, error);
      throw new AutoCompactionPausedError();
    }
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

  private async pauseForAutoCompactionRetry(
    user: User,
    run: AIRun,
    messages: ChatMessage[],
    error: unknown
  ): Promise<void> {
    const retryQuestionId = `${AUTO_COMPACTION_RETRY_PREFIX}${run.id}-${Date.now()}`;
    const question = 'Context compaction failed. Retry compaction to continue this chat.';
    const args = {
      question,
      options: [{ label: AUTO_COMPACTION_RETRY_ANSWER }],
      allowFreeText: false,
      _compactionRetry: true,
    };

    await this.recordToolCall({
      runId: run.id,
      conversationId: run.conversationId,
      toolCallId: retryQuestionId,
      toolName: 'ask_question',
      toolArgs: args,
      status: 'running',
    });
    await this.db.insert(aiRunQuestions).values({
      runId: run.id,
      conversationId: run.conversationId,
      toolCallId: retryQuestionId,
      question,
    });
    await this.setConversationCheckpoint(run.conversationId, {
      type: 'tool_approval_required',
      requestId: run.id,
      id: retryQuestionId,
      name: 'ask_question',
      arguments: args,
      _pendingMessages: messages,
      _allQuestions: [{ id: retryQuestionId, args }],
    } as WSServerMessage);
    await this.updateRunStatus(
      run.id,
      'waiting_for_answer',
      error instanceof Error ? error.message : 'Context compaction failed'
    );
    this.publishConversationChanged(user.id, run.conversationId);
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
      if (message) messages.push({ id: row.id, message });
    }

    if (!options.includeHistoricalToolOutcomes) return messages.map((entry) => entry.message);
    return this.appendHistoricalToolOutcomes(conversationId, messages);
  }

  private async persistAssistantMessageIfNeeded(
    userId: string,
    conversationId: string,
    content: string
  ): Promise<string | null> {
    if (!content.trim()) return null;
    const sequence = await nextMessageSequence(this.db, conversationId);
    const [message] = await this.db
      .insert(aiConversationMessages)
      .values(
        toConversationMessage(
          conversationId,
          {
            role: 'assistant',
            content,
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
    fallbackContent: string
  ): Promise<string | null> {
    const content = this.assistantLiveDrafts.getContent(runId, fallbackContent);
    const assistantMessageId = await this.persistAssistantMessageIfNeeded(userId, conversationId, content);
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
            role: 'assistant',
            content: result.summary,
            compactMarker: true,
            compactedAt: new Date().toISOString(),
            compactedMessageCount: result.compactedMessageCount,
            compactTailMessageCount: result.tailMessageCount,
            compactTrigger: result.trigger,
          },
          sequence
        )
      )
      .returning({ id: aiConversationMessages.id });
    await this.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conversationId));
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
        classification: classifyAIToolForApproval(input.toolName),
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
          classification: classifyAIToolForApproval(input.toolName),
          approvalPolicy: input.status === 'pending_approval' ? 'requires_approval' : 'auto_approved',
          status: input.status,
          updatedAt: new Date(),
        },
      });
  }

  private async finishToolCall(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    error: string | null
  ): Promise<void> {
    const now = new Date();
    const persistedResult = error ? result : redactOneTimeSecretToolResult(toolName, result);
    await this.db
      .update(aiRunToolCalls)
      .set({
        status: error ? 'failed' : 'completed',
        result: persistedResult,
        error,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(aiRunToolCalls.runId, runId), eq(aiRunToolCalls.toolCallId, toolCallId)));
  }

  private async persistPendingInteraction(
    run: AIRun,
    event: Extract<WSServerMessage, { type: 'tool_approval_required' }>,
    assistantMessageId: string | null
  ): Promise<void> {
    if (event.name === 'ask_question') {
      const questions = getQuestionBatch(event);
      await this.db.insert(aiRunQuestions).values(
        questions.map((question) => ({
          runId: run.id,
          conversationId: run.conversationId,
          toolCallId: question.id,
          question: questionTextFromArgs(question.args),
        }))
      );
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
    const [challenge] = await this.db
      .insert(aiRunCredentialChallenges)
      .values({
        runId: run.id,
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
        ...terminal,
      })
      .where(eq(aiRuns.id, runId));
  }

  private logExecutionError(runId: string, error: unknown): void {
    logger.error('AI run execution failed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

function rowsForCompactMarkerBoundary<T extends { uiMessage: Record<string, unknown> }>(
  rows: T[],
  markerIndex: number
): T[] {
  const marker = rows[markerIndex];
  const tailCount =
    typeof marker.uiMessage.compactTailMessageCount === 'number' &&
    Number.isFinite(marker.uiMessage.compactTailMessageCount)
      ? Math.max(0, Math.trunc(marker.uiMessage.compactTailMessageCount))
      : 0;
  const tailStart = Math.max(0, markerIndex - tailCount);
  return [marker, ...rows.slice(tailStart, markerIndex), ...rows.slice(markerIndex + 1)];
}

function compactedRuntimeMessages(messages: ChatMessage[], result: AIContextCompactionResult): ChatMessage[] {
  const tailStart = Math.max(0, messages.length - COMPACTION_TAIL_MESSAGES);
  return [{ role: 'assistant', content: result.summary }, ...messages.slice(tailStart)];
}

function formatHistoricalToolOutcome(toolCall: {
  toolName: string;
  status: string;
  decision: string | null;
  result: unknown;
  error: string | null;
}): string {
  const parts = [`${toolCall.toolName} status=${toolCall.status}`];
  if (toolCall.decision) parts.push(`decision=${toolCall.decision}`);
  if (toolCall.error) {
    parts.push(`error=${safeInlineText(toolCall.error, 600)}`);
  } else if (toolCall.result !== null && toolCall.result !== undefined) {
    const redactedResult = redactOneTimeSecretToolResult(toolCall.toolName, toolCall.result);
    parts.push(`result=${safeJsonPreview(redactedResult, 1200)}`);
  }
  return `- ${parts.join(' ')}`;
}

function safeJsonPreview(value: unknown, maxLength: number): string {
  try {
    return safeInlineText(JSON.stringify(value), maxLength);
  } catch {
    return safeInlineText(String(value), maxLength);
  }
}

function safeInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 15))}...[truncated]`;
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
