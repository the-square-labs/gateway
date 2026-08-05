import { randomUUID } from 'node:crypto';
import type { WSContext } from 'hono/ws';
import { container, TOKENS } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { canUseAI } from '@/lib/permissions.js';
import { withRateLimitRedisTimeout } from '@/lib/rate-limit-timeout.js';
import { AppError } from '@/middleware/error-handler.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import { AISettingsService } from './ai.settings.service.js';
import type { WSClientMessage, WSServerMessage } from './ai.types.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';
import { AIRunService, aiUserConversationsChangedChannel } from './ai-run.service.js';

const logger = createChildLogger('AI-WebSocket');
const RATE_LIMIT_PIPELINE_RESULT_COUNT = 4;

type RedisClient = ReturnType<typeof import('@/services/cache.service.js').createRedisClient>;

interface WSConnectionState {
  user: User | null;
  sessionId: string | null;
  authenticated: boolean;
  subscribedConversationIds: Set<string>;
  runtimeUnsubscribe: (() => void) | null;
  keepaliveInterval: ReturnType<typeof setInterval> | null;
}

function send(ws: WSContext, msg: WSServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may be closed
  }
}

function sendCommandError(
  ws: WSContext,
  msg: WSClientMessage,
  error: unknown,
  fallbackMessage = 'Command failed'
): void {
  if (error instanceof AppError) {
    send(ws, {
      type: 'command.error',
      commandType: msg.type,
      clientCommandId: getClientCommandId(msg),
      conversationId: getConversationId(msg),
      runId: getRunId(msg),
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
    });
    return;
  }

  logger.error('AI websocket command failed', {
    commandType: msg.type,
    error: error instanceof Error ? error.message : String(error),
  });
  send(ws, {
    type: 'command.error',
    commandType: msg.type,
    clientCommandId: getClientCommandId(msg),
    conversationId: getConversationId(msg),
    runId: getRunId(msg),
    code: 'AI_COMMAND_FAILED',
    message: error instanceof Error ? error.message : fallbackMessage,
    statusCode: 500,
  });
}

function getClientCommandId(msg: WSClientMessage): string | undefined {
  return 'clientCommandId' in msg ? msg.clientCommandId : undefined;
}

function getConversationId(msg: WSClientMessage): string | undefined {
  return 'conversationId' in msg ? msg.conversationId : undefined;
}

function getRunId(msg: WSClientMessage): string | undefined {
  return 'runId' in msg ? msg.runId : undefined;
}

function titleFromContent(content: string): string {
  const title = content
    .replace(/<system-instruction>[\s\S]*?<\/system-instruction>\s*/gi, '')
    .trim()
    .replace(/\s+/g, ' ');
  return title ? title.slice(0, 80) : 'New chat';
}

async function sendConversationSnapshot(ws: WSContext, userId: string, conversationId: string) {
  const runService = container.resolve(AIRunService);
  const snapshot = await runService.getConversationSnapshot(userId, conversationId);
  if (!snapshot) throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'AI conversation not found');
  send(ws, { type: 'conversation.snapshot', conversationId, snapshot });
  return snapshot;
}

async function resumeResolvedCredentialContinuation(
  user: User,
  snapshot: Awaited<ReturnType<AIRunService['getConversationSnapshot']>>
) {
  if (!snapshot) return;
  const activeRun = snapshot.runtime.activeRun;
  if (activeRun?.status !== 'waiting_for_credential' || snapshot.runtime.pendingCredentialChallenge) return;
  await container.resolve(AIRunService).resumeResolvedCredentialContinuation(user, {
    conversationId: activeRun.conversationId,
    runId: activeRun.id,
  });
}

function subscribeToUserRuntime(ws: WSContext, state: WSConnectionState, userId: string): void {
  if (state.runtimeUnsubscribe) return;
  const eventBus = container.resolve(EventBusService);
  state.runtimeUnsubscribe = eventBus.subscribe(aiUserConversationsChangedChannel(userId), (payload) => {
    const event = payload as {
      type?: string;
      userId?: string;
      conversationId?: string;
      runId?: string;
      content?: string;
      version?: number;
      invalidatedStores?: string[];
      challenge?: Extract<WSServerMessage, { type: 'credential.required' }>['challenge'];
      action?: Record<string, unknown>;
    };
    if (event.userId !== userId || typeof event.conversationId !== 'string') return;
    if (event.type === 'credential.required') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        event.challenge
      ) {
        send(ws, {
          type: 'credential.required',
          conversationId: event.conversationId,
          runId: event.runId,
          challenge: event.challenge,
        });
      }
      return;
    }
    if (event.type === 'client.action') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        event.action
      ) {
        send(ws, {
          type: 'client.action',
          conversationId: event.conversationId,
          runId: event.runId,
          action: event.action,
        });
      }
      return;
    }
    if (event.type === 'assistant.comment_done') {
      if (state.subscribedConversationIds.has(event.conversationId) && typeof event.runId === 'string') {
        send(ws, {
          type: 'assistant.comment_done',
          conversationId: event.conversationId,
          runId: event.runId,
        });
      }
      return;
    }
    if (event.type === 'assistant.delta' || event.type === 'assistant.comment_delta') {
      if (
        state.subscribedConversationIds.has(event.conversationId) &&
        typeof event.runId === 'string' &&
        typeof event.content === 'string' &&
        typeof event.version === 'number'
      ) {
        send(ws, {
          type: event.type,
          conversationId: event.conversationId,
          runId: event.runId,
          content: event.content,
          version: event.version,
        });
      }
      return;
    }
    if (event.invalidatedStores?.length) {
      send(ws, {
        type: 'stores.invalidated',
        conversationId: event.conversationId,
        stores: event.invalidatedStores,
      });
    }
    void sendConversationSnapshot(ws, userId, event.conversationId).catch((error) => {
      logger.warn('Failed to send AI conversation snapshot from event', {
        conversationId: event.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function unsubscribeFromUserRuntime(state: WSConnectionState): void {
  state.runtimeUnsubscribe?.();
  state.runtimeUnsubscribe = null;
}

async function authenticateFromSession(sessionId: string): Promise<User | null> {
  const sessionService = container.resolve(SessionService);
  const session = await sessionService.getSession(sessionId);
  const sessionUserId = session?.userId ?? session?.user?.id;
  if (!sessionUserId) return null;

  // Always resolve live scopes from the group (not stale session cache)
  const { AuthService } = await import('@/modules/auth/auth.service.js');
  const authService = container.resolve(AuthService);
  const freshUser = await authService.getUserById(sessionUserId);
  return freshUser;
}

interface AIRateLimitResult {
  allowed: boolean;
  retryAfter: number;
  unavailable?: boolean;
}

function getRateLimitCount(results: unknown): number {
  if (!Array.isArray(results)) throw new Error('Redis pipeline returned no results');
  if (results.length !== RATE_LIMIT_PIPELINE_RESULT_COUNT) {
    throw new Error('Redis pipeline returned incomplete results');
  }
  for (const result of results) {
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Redis pipeline returned malformed result');
    }
    const [error] = result;
    if (error) throw error;
  }
  const count = results[1]?.[1];
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error('Redis pipeline returned invalid request count');
  }
  return count;
}

async function checkRateLimit(userId: string): Promise<AIRateLimitResult> {
  const settingsService = container.resolve(AISettingsService);
  const config = await settingsService.getConfig();
  if (config.providerType === 'gateway_inference') {
    return { allowed: true, retryAfter: 0 };
  }

  const key = `ai-ratelimit:${userId}`;
  const now = Date.now();
  const windowMs = config.rateLimitWindowSeconds * 1000;
  const windowStart = now - windowMs;

  try {
    const redis = container.resolve<RedisClient>(TOKENS.RedisClient);
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}-${randomUUID()}`);
    pipeline.expire(key, config.rateLimitWindowSeconds + 1);

    const results = await withRateLimitRedisTimeout(pipeline.exec());
    const requestCount = getRateLimitCount(results);

    if (requestCount >= config.rateLimitMax) {
      return { allowed: false, retryAfter: config.rateLimitWindowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  } catch (error) {
    logger.warn('AI rate limiter unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: false, retryAfter: 0, unavailable: true };
  }
}

// WeakMap to store per-connection state
const wsStates = new WeakMap<WSContext, WSConnectionState>();

export function createWSHandlers() {
  return {
    onOpen(_event: Event, ws: WSContext) {
      const state: WSConnectionState = {
        user: null,
        sessionId: null,
        authenticated: false,
        subscribedConversationIds: new Set(),
        runtimeUnsubscribe: null,
        keepaliveInterval: null,
      };

      wsStates.set(ws, state);

      state.keepaliveInterval = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        }
      }, 30_000);
    },

    async onMessage(event: MessageEvent, ws: WSContext) {
      const state = wsStates.get(ws);
      if (!state) return;

      let raw: Record<string, unknown>;
      let msg: WSClientMessage;
      try {
        const parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
          send(ws, { type: 'error', requestId: '', message: 'Invalid message format' });
          return;
        }
        raw = parsed as Record<string, unknown>;
        msg = raw as WSClientMessage;
      } catch {
        send(ws, { type: 'error', requestId: '', message: 'Invalid JSON' });
        return;
      }

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }

      if (!state.authenticated) {
        send(ws, { type: 'auth_error', message: 'Not authenticated' });
        return;
      }

      // Re-validate session on each message to catch role changes
      if (state.sessionId) {
        const freshUser = await authenticateFromSession(state.sessionId);
        if (!freshUser || freshUser.isBlocked || !canUseAI(freshUser.scopes)) {
          send(ws, { type: 'auth_error', message: 'Session expired or role changed' });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        state.user = freshUser;
      }

      const user = state.user!;

      if (msg.type === 'conversation.subscribe') {
        try {
          state.subscribedConversationIds.add(msg.conversationId);
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
          });
          const snapshot = await sendConversationSnapshot(ws, user.id, msg.conversationId);
          await resumeResolvedCredentialContinuation(user, snapshot);
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to subscribe to conversation');
        }
        return;
      }

      if (msg.type === 'conversation.unsubscribe') {
        state.subscribedConversationIds.delete(msg.conversationId);
        send(ws, { type: 'command.ack', commandType: msg.type, conversationId: msg.conversationId });
        return;
      }

      if (msg.type === 'conversation.sync') {
        try {
          const snapshot = await sendConversationSnapshot(ws, user.id, msg.conversationId);
          await resumeResolvedCredentialContinuation(user, snapshot);
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
          });
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to sync conversation');
        }
        return;
      }

      if (msg.type === 'conversation.send_message') {
        try {
          const content = msg.content.trim();
          if (!content) throw new AppError(400, 'AI_MESSAGE_REQUIRED', 'Message content is required');
          const model = msg.model?.trim();
          if (model && model.length > 255) {
            throw new AppError(400, 'AI_MODEL_INVALID', 'AI model identifier is too long');
          }
          const reasoningEffort = msg.reasoningEffort?.trim();
          if (reasoningEffort && reasoningEffort.length > 64) {
            throw new AppError(400, 'AI_REASONING_EFFORT_INVALID', 'AI reasoning effort is too long');
          }

          const rateCheck = await checkRateLimit(user.id);
          if (!rateCheck.allowed) {
            const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
            throw new AppError(
              rateCheck.unavailable ? 503 : 429,
              code,
              rateCheck.unavailable ? 'Gateway is temporarily unavailable' : 'AI rate limit exceeded',
              rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
            );
          }

          const runService = container.resolve(AIRunService);
          const result = await runService.startUserRun({
            conversationId: msg.conversationId ?? null,
            userId: user.id,
            title: titleFromContent(content),
            userMessage: {
              role: 'user',
              content,
              ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
            },
            clientCommandId: msg.clientCommandId,
            lastContext: msg.context ? { ...msg.context } : null,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });

          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: result.conversationId,
            runId: result.run.id,
            duplicate: result.duplicate,
          });
          state.subscribedConversationIds.add(result.conversationId);
          const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
          send(ws, {
            type: 'run.status_changed',
            conversationId: result.conversationId,
            run: snapshot.runtime.activeRun,
          });
          if (!result.duplicate) {
            runService.startRunExecution(user, result.run.id);
          }
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to send AI message');
        }
        return;
      }

      if (msg.type === 'conversation.compact') {
        try {
          const model = msg.model?.trim();
          if (model && model.length > 255) {
            throw new AppError(400, 'AI_MODEL_INVALID', 'AI model identifier is too long');
          }
          const reasoningEffort = msg.reasoningEffort?.trim();
          if (reasoningEffort && reasoningEffort.length > 64) {
            throw new AppError(400, 'AI_REASONING_EFFORT_INVALID', 'AI reasoning effort is too long');
          }
          const rateCheck = await checkRateLimit(user.id);
          if (!rateCheck.allowed) {
            const code = rateCheck.unavailable ? 'RATE_LIMIT_UNAVAILABLE' : 'RATE_LIMITED';
            throw new AppError(
              rateCheck.unavailable ? 503 : 429,
              code,
              rateCheck.unavailable ? 'Gateway is temporarily unavailable' : 'AI rate limit exceeded',
              rateCheck.unavailable ? undefined : { retryAfter: rateCheck.retryAfter }
            );
          }

          const runService = container.resolve(AIRunService);
          const result = await runService.startContextCompactionRun({
            conversationId: msg.conversationId,
            userId: user.id,
            clientCommandId: msg.clientCommandId,
            lastContext: msg.context ? { ...msg.context } : null,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });

          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: result.conversationId,
            runId: result.run.id,
            duplicate: result.duplicate,
          });
          state.subscribedConversationIds.add(result.conversationId);
          const snapshot = await sendConversationSnapshot(ws, user.id, result.conversationId);
          send(ws, {
            type: 'run.status_changed',
            conversationId: result.conversationId,
            run: snapshot.runtime.activeRun,
          });
          if (!result.duplicate) {
            runService.startContextCompaction(user, result.run.id, 'manual');
          }
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to compact AI conversation');
        }
        return;
      }

      if (msg.type === 'run.stop') {
        try {
          const runService = container.resolve(AIRunService);
          const result = await runService.stopRun({
            conversationId: msg.conversationId,
            runId: msg.runId,
            userId: user.id,
          });
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
            runId: msg.runId,
            duplicate: result.duplicate,
          });
          send(ws, { type: 'run.status_changed', conversationId: msg.conversationId, run: result.run });
          await sendConversationSnapshot(ws, user.id, msg.conversationId);
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to stop AI run');
        }
        return;
      }

      if (msg.type === 'approval.decide') {
        try {
          const runService = container.resolve(AIRunService);
          const result = await runService.decideToolCall({
            conversationId: msg.conversationId,
            runId: msg.runId,
            toolCallId: msg.approvalId,
            userId: user.id,
            clientCommandId: msg.clientCommandId,
            decision: msg.decision,
          });
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
            runId: msg.runId,
            duplicate: result.duplicate,
          });
          send(ws, {
            type: 'approval.updated',
            conversationId: msg.conversationId,
            runId: msg.runId,
            approval: result.toolCall,
            duplicate: result.duplicate,
          });
          await sendConversationSnapshot(ws, user.id, msg.conversationId);
          if (!result.duplicate) {
            runService.startApprovalContinuation(user, {
              conversationId: msg.conversationId,
              runId: msg.runId,
              toolCall: result.toolCall,
              approved: msg.decision === 'approved',
            });
          }
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to decide AI tool approval');
        }
        return;
      }

      if (msg.type === 'credential.resolve') {
        try {
          const runService = container.resolve(AIRunService);
          const result = await runService.resolveCredentialChallenge({
            conversationId: msg.conversationId,
            runId: msg.runId,
            challengeId: msg.challengeId,
            userId: user.id,
            clientCommandId: msg.clientCommandId,
            decision: msg.decision,
          });
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
            runId: msg.runId,
            duplicate: result.duplicate,
          });
          send(ws, {
            type: 'credential.updated',
            conversationId: msg.conversationId,
            runId: msg.runId,
            challenge: result.challenge,
            duplicate: result.duplicate,
          });
          await sendConversationSnapshot(ws, user.id, msg.conversationId);
          for (const challenge of [result.challenge, ...result.additionalChallenges]) {
            runService.startCredentialContinuation(user, {
              conversationId: challenge.conversationId,
              runId: challenge.runId,
              challenge,
              authorized: msg.decision === 'authorized',
            });
          }
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to resolve GitLab authorization');
        }
        return;
      }

      if (msg.type === 'question.answer') {
        try {
          const runService = container.resolve(AIRunService);
          const result = await runService.answerQuestion({
            conversationId: msg.conversationId,
            runId: msg.runId,
            questionId: msg.questionId,
            userId: user.id,
            clientCommandId: msg.clientCommandId,
            answer: msg.answer,
          });
          send(ws, {
            type: 'command.ack',
            commandType: msg.type,
            clientCommandId: msg.clientCommandId,
            conversationId: msg.conversationId,
            runId: msg.runId,
            duplicate: result.duplicate,
          });
          send(ws, {
            type: 'question.answered',
            conversationId: msg.conversationId,
            runId: msg.runId,
            question: result.question,
            duplicate: result.duplicate,
          });
          await sendConversationSnapshot(ws, user.id, msg.conversationId);
          if (!result.duplicate && result.remainingPendingQuestions.length === 0) {
            runService.startQuestionContinuation(user, {
              conversationId: msg.conversationId,
              runId: msg.runId,
              question: result.question,
            });
          }
        } catch (error) {
          sendCommandError(ws, msg, error, 'Failed to answer AI question');
        }
        return;
      }

      send(ws, {
        type: 'command.error',
        commandType: raw.type as string,
        clientCommandId:
          typeof raw.clientCommandId === 'string' ? raw.clientCommandId : (raw.requestId as string | undefined),
        conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : undefined,
        runId: typeof raw.runId === 'string' ? raw.runId : undefined,
        code: 'AI_UNKNOWN_COMMAND',
        message: 'Unknown AI websocket command',
        statusCode: 400,
      });
    },

    onClose(_event: unknown, ws: WSContext) {
      const state = wsStates.get(ws);
      if (state) {
        unsubscribeFromUserRuntime(state);
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
    },

    onError(_error: Event, ws: WSContext) {
      logger.error('WebSocket error');
      const state = wsStates.get(ws);
      if (state) {
        unsubscribeFromUserRuntime(state);
        if (state.keepaliveInterval) clearInterval(state.keepaliveInterval);
        wsStates.delete(ws);
      }
    },
  };
}

/**
 * Authenticate and initialize a WS connection from the session cookie.
 * Called during the WS upgrade / onOpen.
 */
export async function authenticateWSConnection(ws: WSContext, sessionId: string): Promise<boolean> {
  const state = wsStates.get(ws);
  if (!state) return false;

  const user = await authenticateFromSession(sessionId);
  if (!user) {
    send(ws, { type: 'auth_error', message: 'Invalid or expired session' });
    return false;
  }

  if (user.isBlocked) {
    send(ws, { type: 'auth_error', message: 'Account is blocked' });
    return false;
  }

  if (!canUseAI(user.scopes)) {
    send(ws, { type: 'auth_error', message: 'Insufficient permissions to use AI assistant' });
    return false;
  }

  const settingsService = container.resolve(AISettingsService);
  const enabled = container.isRegistered(AIProviderRuntimeService)
    ? (await container.resolve(AIProviderRuntimeService).statusForUser(user)).enabled
    : await settingsService.isEnabled();
  if (!enabled) {
    send(ws, { type: 'auth_error', message: 'AI assistant is not enabled' });
    return false;
  }

  state.user = user;
  state.sessionId = sessionId;
  state.authenticated = true;
  subscribeToUserRuntime(ws, state, user.id);
  send(ws, { type: 'auth_ok', userId: user.id });
  return true;
}
