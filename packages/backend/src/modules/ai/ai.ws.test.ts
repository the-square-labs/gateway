import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { RATE_LIMIT_REDIS_TIMEOUT_MS } from '@/lib/rate-limit-timeout.js';
import { AppError } from '@/middleware/error-handler.js';
import { getAuditRequestContext } from '@/modules/audit/audit-request-context.js';
import { EventBusService } from '@/services/event-bus.service.js';
import { SessionService } from '@/services/session.service.js';
import type { User } from '@/types.js';
import { AISettingsService } from './ai.settings.service.js';
import { authenticateWSConnection, createWSHandlers } from './ai.ws.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';
import { AIRunService, aiUserConversationsChangedChannel } from './ai-run.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  requireGateway2fa: false,
  groupScopes: ['ai:workspace:use'],
  additionalScopes: [],
  scopes: ['ai:workspace:use'],
  isBlocked: false,
  isDeleted: false,
  authMethod: undefined,
  aiApprovalMode: undefined,
};

function createWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
  };
}

function registerAiWsDependencies(user: User) {
  container.registerInstance(EventBusService, new EventBusService());
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue({
      userId: user.id,
      user,
      purpose: 'user',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue(user) },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: user.groupId, parentId: null, name: user.groupName, scopes: user.scopes }]),
      },
    },
  } as unknown as DrizzleClient);
  container.registerInstance(AISettingsService, {
    isEnabled: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockResolvedValue({
      rateLimitMax: 10,
      rateLimitWindowSeconds: 60,
    }),
  } as unknown as AISettingsService);
  container.registerInstance(AIProviderRuntimeService, {
    statusForUser: vi.fn().mockResolvedValue({ enabled: true }),
    generateConversationTitle: vi.fn(async (_user, options: { content: string }) => options.content.slice(0, 80)),
  } as unknown as AIProviderRuntimeService);
}

function allowingRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn(() => pipeline),
    zcard: vi.fn(() => pipeline),
    zadd: vi.fn(() => pipeline),
    expire: vi.fn(() => pipeline),
    exec: vi.fn().mockResolvedValue([
      [null, 0],
      [null, 0],
      [null, 1],
      [null, 1],
    ]),
  };
  return { pipeline: vi.fn(() => pipeline) };
}

function throwingRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn(() => pipeline),
    zcard: vi.fn(() => pipeline),
    zadd: vi.fn(() => pipeline),
    expire: vi.fn(() => pipeline),
    exec: vi.fn().mockRejectedValue(new Error('redis down')),
  };
  return { pipeline };
}

function hangingRedis() {
  const pipeline = {
    zremrangebyscore: vi.fn(() => pipeline),
    zcard: vi.fn(() => pipeline),
    zadd: vi.fn(() => pipeline),
    expire: vi.fn(() => pipeline),
    exec: vi.fn().mockReturnValue(new Promise<never>(() => {})),
  };
  return { pipeline };
}

function createRun() {
  return {
    id: 'run-1',
    conversationId: 'conversation-1',
    userId: USER.id,
    status: 'queued',
    activeMessageId: 'message-1',
    clientCommandId: 'cmd-1',
  };
}

function createSnapshot(run: ReturnType<typeof createRun> | null = createRun()) {
  return {
    revision: 7,
    conversation: {
      id: 'conversation-1',
      title: 'hello',
      createdAt: new Date('2026-06-26T00:00:00.000Z'),
      updatedAt: new Date('2026-06-26T00:00:00.000Z'),
      folderId: null,
      lastUserMessageAt: new Date('2026-06-26T00:00:00.000Z'),
      messageCount: 1,
      status: 'active' as const,
      blockReason: null,
      lastContext: { route: '/nodes' },
      discoveredToolsets: [],
      checkpoint: null,
    },
    messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
    runtime: {
      activeRun: run,
      pendingApprovals: [],
      pendingQuestion: null,
      pendingQuestions: [],
      toolCalls: [],
    },
  };
}

async function openAuthenticatedWs(user: User = USER) {
  registerAiWsDependencies(user);
  const ws = createWs();
  const handlers = createWSHandlers();

  handlers.onOpen(new Event('open'), ws as any);
  const authenticated = await authenticateWSConnection(ws as any, 'session-1');
  expect(authenticated).toBe(true);
  return { ws, handlers };
}

afterEach(() => {
  container.reset();
  vi.useRealTimers();
});

describe('AI websocket authentication', () => {
  it('rejects blocked session users', async () => {
    registerAiWsDependencies({ ...USER, isBlocked: true });
    const ws = createWs();
    const handlers = createWSHandlers();

    handlers.onOpen(new Event('open'), ws as any);
    const authenticated = await authenticateWSConnection(ws as any, 'session-1');
    handlers.onClose(new Event('close'), ws as any);

    expect(authenticated).toBe(false);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'auth_error', message: 'Account is blocked' }));
  });

  it('keeps the administrator as audit actor for impersonated AI commands', async () => {
    const actor = {
      ...USER,
      id: 'actor-1',
      email: 'actor@example.com',
      groupId: 'actor-group',
      groupName: 'system-admin',
      groupScopes: ['admin:users:impersonate', 'ai:workspace:use'],
      scopes: ['admin:users:impersonate', 'ai:workspace:use'],
    };
    const subject = {
      ...USER,
      id: 'subject-1',
      email: 'subject@example.com',
      name: 'Subject',
      groupId: 'subject-group',
      groupName: 'viewer',
    };
    const impersonationSession = {
      userId: subject.id,
      user: subject,
      purpose: 'impersonation' as const,
      impersonation: { actorUserId: actor.id, originalSessionId: 'original-session' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    container.registerInstance(EventBusService, new EventBusService());
    container.registerInstance(SessionService, {
      getSession: vi.fn().mockResolvedValue(impersonationSession),
      getOriginalSessionForImpersonation: vi.fn().mockResolvedValue({
        sessionId: 'original-session',
        session: {
          userId: actor.id,
          user: actor,
          purpose: 'user',
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      }),
    } as unknown as SessionService);
    container.registerInstance(TOKENS.DrizzleClient, {
      query: {
        users: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(subject)
            .mockResolvedValueOnce(actor)
            .mockResolvedValueOnce(subject)
            .mockResolvedValueOnce(actor),
        },
        permissionGroups: {
          findMany: vi.fn().mockResolvedValue([
            { id: actor.groupId, parentId: null, name: actor.groupName, scopes: actor.scopes },
            { id: subject.groupId, parentId: null, name: subject.groupName, scopes: subject.scopes },
          ]),
        },
      },
    } as unknown as DrizzleClient);
    container.registerInstance(AISettingsService, {
      isEnabled: vi.fn().mockResolvedValue(true),
    } as unknown as AISettingsService);
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({ enabled: true }),
    } as unknown as AIProviderRuntimeService);
    let capturedImpersonation = getAuditRequestContext()?.impersonation;
    container.registerInstance(AIRunService, {
      getConversationSnapshot: vi.fn().mockImplementation(async () => {
        capturedImpersonation = getAuditRequestContext()?.impersonation;
        return createSnapshot(null);
      }),
    } as unknown as AIRunService);

    const ws = createWs();
    const handlers = createWSHandlers();
    handlers.onOpen(new Event('open'), ws as any);
    await expect(authenticateWSConnection(ws as any, 'impersonation-session')).resolves.toBe(true);
    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          clientCommandId: 'cmd-subscribe',
          conversationId: 'conversation-1',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(capturedImpersonation).toEqual({
      actorUserId: actor.id,
      subjectUserId: subject.id,
      subjectEmail: subject.email,
      subjectName: subject.name,
    });
  });
});

describe('AI websocket backend runtime commands', () => {
  it('fails closed when the runtime send-message rate limiter cannot reach Redis', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, throwingRedis() as any);
    const startUserRun = vi.fn();
    container.registerInstance(AIRunService, { startUserRun } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-rate-limit',
          content: 'hello',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(startUserRun).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-rate-limit',
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Gateway is temporarily unavailable',
        statusCode: 503,
      })
    );
  });

  it('fails closed when the runtime send-message rate limiter stalls', async () => {
    vi.useFakeTimers();
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, hangingRedis() as any);
    const startUserRun = vi.fn();
    container.registerInstance(AIRunService, { startUserRun } as unknown as AIRunService);

    const messagePromise = handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-timeout',
          content: 'hello',
        }),
      }),
      ws as any
    );
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_REDIS_TIMEOUT_MS);
    await messagePromise;
    handlers.onClose(new Event('close'), ws as any);

    expect(startUserRun).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-timeout',
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Gateway is temporarily unavailable',
        statusCode: 503,
      })
    );
  });

  it('starts a backend-owned run and sends a conversation snapshot', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);

    const run = createRun();
    const snapshot = createSnapshot(run);
    const startUserRun = vi.fn().mockResolvedValue({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });
    const getConversationSnapshot = vi.fn().mockResolvedValue(snapshot);
    const startRunExecution = vi.fn();
    const generateConversationTitle = vi.fn().mockResolvedValue('Node inventory overview');
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({ enabled: true }),
      generateConversationTitle,
    } as unknown as AIProviderRuntimeService);
    container.registerInstance(AIRunService, {
      startUserRun,
      getConversationSnapshot,
      startRunExecution,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-1',
          content: ' hello ',
          context: { route: '/nodes' },
          model: 'gateway-model',
          reasoningEffort: 'high',
        }),
      }),
      ws as any
    );

    expect(startUserRun).toHaveBeenCalledWith({
      conversationId: null,
      userId: USER.id,
      title: 'Node inventory overview',
      userMessage: { role: 'user', content: 'hello' },
      clientCommandId: 'cmd-1',
      lastContext: { route: '/nodes' },
      model: 'gateway-model',
      reasoningEffort: 'high',
    });
    expect(generateConversationTitle).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        requestId: 'conversation-title:cmd-1',
        content: 'hello',
        requestedModel: 'gateway-model',
      })
    );
    expect(generateConversationTitle.mock.invocationCallOrder[0]).toBeLessThan(
      startUserRun.mock.invocationCallOrder[0]!
    );
    expect(getConversationSnapshot).toHaveBeenCalledWith(USER.id, 'conversation-1');
    expect(startRunExecution).toHaveBeenCalledWith(USER, 'run-1');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.ack',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-1',
        conversationId: 'conversation-1',
        runId: 'run-1',
        duplicate: false,
      })
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'conversation.snapshot', conversationId: 'conversation-1', snapshot })
    );

    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      userId: USER.id,
      conversationId: 'conversation-1',
    });
    await Promise.resolve();
    expect(getConversationSnapshot).toHaveBeenCalledTimes(2);
    handlers.onClose(new Event('close'), ws as any);
  });

  it('starts an image-only message when the selected model supports images', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);

    const run = createRun();
    const snapshot = createSnapshot(run);
    const attachment = {
      artifactId: 'artifact-1',
      filename: 'screen.png',
      mediaType: 'image/png',
      sizeBytes: 123,
      downloadUrl: '/api/ai/sandbox/artifacts/artifact-1/download',
      kind: 'image' as const,
    };
    const startUserRun = vi.fn().mockResolvedValue({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });
    const generateConversationTitle = vi.fn().mockResolvedValue('Attached screen');
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({
        enabled: true,
        providerType: 'gateway_inference',
        defaultModel: 'vision-model',
        allowUserModelSelection: true,
        supportsImages: true,
        models: [{ id: 'vision-model', supportsImages: true }],
      }),
      generateConversationTitle,
    } as unknown as AIProviderRuntimeService);
    container.registerInstance(AIRunService, {
      startUserRun,
      getConversationSnapshot: vi.fn().mockResolvedValue(snapshot),
      startRunExecution: vi.fn(),
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-image',
          content: ' ',
          attachments: [attachment],
          model: 'vision-model',
        }),
      }),
      ws as any
    );

    expect(generateConversationTitle).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ content: '', attachments: [attachment], requestedModel: 'vision-model' })
    );
    expect(startUserRun).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Attached screen',
        userMessage: { role: 'user', content: '', attachments: [attachment] },
        model: 'vision-model',
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('rejects image attachments for a model without image capability', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);
    const startUserRun = vi.fn();
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({
        enabled: true,
        providerType: 'gateway_inference',
        defaultModel: 'text-model',
        allowUserModelSelection: true,
        supportsImages: false,
        models: [{ id: 'text-model', supportsImages: false }],
      }),
      generateConversationTitle: vi.fn(),
    } as unknown as AIProviderRuntimeService);
    container.registerInstance(AIRunService, { startUserRun } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-image-unsupported',
          content: 'Describe this',
          attachments: [
            {
              artifactId: 'artifact-1',
              filename: 'screen.png',
              mediaType: 'image/png',
              sizeBytes: 123,
              downloadUrl: '/api/ai/sandbox/artifacts/artifact-1/download',
              kind: 'image',
            },
          ],
          model: 'text-model',
        }),
      }),
      ws as any
    );

    expect(startUserRun).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-image-unsupported',
        code: 'AI_IMAGE_INPUT_UNSUPPORTED',
        message: 'The selected AI model does not support image attachments',
        statusCode: 400,
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('continues an interrupted conversation without creating another visible user message', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);

    const run = { ...createRun(), id: 'run-2', clientCommandId: 'continue:cmd-continue' };
    const snapshot = createSnapshot(run);
    const startContinuationRun = vi.fn().mockResolvedValue({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });
    const getConversationSnapshot = vi.fn().mockResolvedValue(snapshot);
    const startRunExecution = vi.fn();
    container.registerInstance(AIRunService, {
      startContinuationRun,
      getConversationSnapshot,
      startRunExecution,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.continue',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-continue',
          context: { route: '/docker/containers' },
          model: 'gateway-model',
          reasoningEffort: 'low',
        }),
      }),
      ws as any
    );

    expect(startContinuationRun).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId: USER.id,
      clientCommandId: 'cmd-continue',
      lastContext: { route: '/docker/containers' },
      model: 'gateway-model',
      reasoningEffort: 'low',
    });
    expect(startRunExecution).toHaveBeenCalledWith(USER, 'run-2');
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.ack',
        commandType: 'conversation.continue',
        clientCommandId: 'cmd-continue',
        conversationId: 'conversation-1',
        runId: 'run-2',
        duplicate: false,
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('generates a new conversation title from user-visible content only', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);

    const run = createRun();
    const snapshot = createSnapshot(run);
    const startUserRun = vi.fn().mockResolvedValue({
      conversationId: 'conversation-1',
      userMessageId: 'message-1',
      run,
      duplicate: false,
    });
    container.registerInstance(AIRunService, {
      startUserRun,
      getConversationSnapshot: vi.fn().mockResolvedValue(snapshot),
      startRunExecution: vi.fn(),
    } as unknown as AIRunService);
    const generateConversationTitle = vi.fn().mockResolvedValue('Container launch');
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({ enabled: true }),
      generateConversationTitle,
    } as unknown as AIProviderRuntimeService);

    const content =
      '<system-instruction>The user typed "start container" in the command palette.</system-instruction>\nstart container';
    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          clientCommandId: 'cmd-command-palette',
          content,
        }),
      }),
      ws as any
    );

    expect(startUserRun).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Container launch',
        userMessage: { role: 'user', content },
      })
    );
    expect(generateConversationTitle).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ content: 'start container' })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('rejects send-message commands for locked conversations without starting a run', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);

    const startUserRun = vi
      .fn()
      .mockRejectedValue(new AppError(409, 'AI_CONVERSATION_ENDED', 'This conversation has ended'));
    const getConversationSnapshot = vi.fn();
    const startRunExecution = vi.fn();
    container.registerInstance(AIRunService, {
      startUserRun,
      getConversationSnapshot,
      startRunExecution,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-locked',
          content: 'let me continue',
        }),
      }),
      ws as any
    );

    expect(startUserRun).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId: USER.id,
      title: 'New Work Session',
      userMessage: { role: 'user', content: 'let me continue' },
      clientCommandId: 'cmd-locked',
      lastContext: null,
    });
    expect(getConversationSnapshot).not.toHaveBeenCalled();
    expect(startRunExecution).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-locked',
        conversationId: 'conversation-1',
        code: 'AI_CONVERSATION_ENDED',
        message: 'This conversation has ended',
        statusCode: 409,
      })
    );
    handlers.onClose(new Event('close'), ws as any);
  });

  it('forwards assistant deltas without fetching a fresh conversation snapshot', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(createRun()));
    container.registerInstance(AIRunService, {
      getConversationSnapshot,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-subscribe',
        }),
      }),
      ws as any
    );
    vi.mocked(ws.send).mockClear();

    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      type: 'assistant.delta',
      userId: USER.id,
      conversationId: 'conversation-1',
      runId: 'run-1',
      content: 'hello',
      version: 1,
    });
    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      type: 'assistant.delta',
      userId: USER.id,
      conversationId: 'conversation-2',
      runId: 'run-2',
      content: 'ignored',
      version: 1,
    });
    handlers.onClose(new Event('close'), ws as any);

    expect(getConversationSnapshot).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'assistant.delta',
        conversationId: 'conversation-1',
        runId: 'run-1',
        content: 'hello',
        version: 1,
      })
    );
  });

  it('forwards plan status changes with the authoritative conversation revision', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const plan = {
      id: 'plan-1',
      conversationId: 'conversation-1',
      status: 'awaiting_decision',
      revisionId: 'revision-1',
      publishedAt: '2026-08-12T00:01:00.000Z',
    };
    const baseSnapshot = createSnapshot(createRun());
    const snapshot = {
      ...baseSnapshot,
      runtime: { ...baseSnapshot.runtime, activePlan: plan },
    };
    const getConversationSnapshot = vi.fn().mockResolvedValue(snapshot);
    container.registerInstance(AIRunService, {
      getConversationSnapshot,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-subscribe',
        }),
      }),
      ws as any
    );
    vi.mocked(ws.send).mockClear();

    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      userId: USER.id,
      conversationId: 'conversation-1',
    });
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    handlers.onClose(new Event('close'), ws as any);

    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'plan.status_changed',
        conversationId: 'conversation-1',
        plan,
        revision: 7,
      })
    );
  });

  it('forwards client actions only to the subscribed conversation', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(createRun()));
    container.registerInstance(AIRunService, {
      getConversationSnapshot,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-subscribe',
        }),
      }),
      ws as any
    );
    vi.mocked(ws.send).mockClear();

    const action = {
      type: 'set_resource_pin',
      resourceType: 'node',
      resourceId: 'node-1',
      target: 'dashboard',
      pinned: true,
    };
    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      type: 'client.action',
      userId: USER.id,
      conversationId: 'conversation-1',
      runId: 'run-1',
      action,
    });
    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      type: 'client.action',
      userId: USER.id,
      conversationId: 'conversation-2',
      runId: 'run-2',
      action,
    });
    handlers.onClose(new Event('close'), ws as any);

    expect(getConversationSnapshot).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'client.action', conversationId: 'conversation-1', runId: 'run-1', action })
    );
  });

  it('forwards credential challenges with the authoritative conversation revision', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(createRun()));
    container.registerInstance(AIRunService, {
      getConversationSnapshot,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-subscribe',
        }),
      }),
      ws as any
    );
    vi.mocked(ws.send).mockClear();

    const challenge = {
      id: 'challenge-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      userId: USER.id,
      provider: 'gitlab' as const,
      connectorId: 'connector-1',
      toolCallId: 'tool-1',
      toolName: 'gitlab_list_projects',
      status: 'pending' as const,
      decisionClientCommandId: null,
      resolvedAt: null,
      createdAt: new Date('2026-06-26T10:00:00.000Z'),
      updatedAt: new Date('2026-06-26T10:00:00.000Z'),
    };
    container.resolve(EventBusService).publish(aiUserConversationsChangedChannel(USER.id), {
      type: 'credential.required',
      userId: USER.id,
      conversationId: 'conversation-1',
      runId: 'run-1',
      challenge,
    });
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    handlers.onClose(new Event('close'), ws as any);

    expect(getConversationSnapshot).toHaveBeenCalledTimes(2);
    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'conversation.snapshot',
        conversationId: 'conversation-1',
        snapshot: createSnapshot(createRun()),
      })
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: 'credential.required',
        conversationId: 'conversation-1',
        runId: 'run-1',
        challenge,
        revision: 7,
      })
    );
  });

  it('restarts a resolved credential continuation when subscribing after a process gap', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const run = { ...createRun(), status: 'waiting_for_credential' };
    const snapshot = createSnapshot(run);
    const resumeResolvedCredentialContinuation = vi.fn().mockResolvedValue(true);
    container.registerInstance(AIRunService, {
      getConversationSnapshot: vi.fn().mockResolvedValue(snapshot),
      resumeResolvedCredentialContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.subscribe',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-recover',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(resumeResolvedCredentialContinuation).toHaveBeenCalledWith(USER, {
      conversationId: 'conversation-1',
      runId: 'run-1',
    });
  });

  it('returns command.error when a conversation already has an active run', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    container.registerInstance(TOKENS.RedisClient, allowingRedis() as any);
    container.registerInstance(AIRunService, {
      startUserRun: vi
        .fn()
        .mockRejectedValue(new AppError(409, 'AI_RUN_ACTIVE', 'Conversation already has an active AI run')),
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'conversation.send_message',
          conversationId: 'conversation-1',
          clientCommandId: 'cmd-2',
          content: 'second',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'conversation.send_message',
        clientCommandId: 'cmd-2',
        conversationId: 'conversation-1',
        code: 'AI_RUN_ACTIVE',
        message: 'Conversation already has an active AI run',
        statusCode: 409,
      })
    );
  });

  it('routes approval decisions through the backend run service', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const toolCall = {
      id: 'approval-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'approved',
      decision: 'approved',
    };
    const decideToolCall = vi.fn().mockResolvedValue({ toolCall, duplicate: false });
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(null));
    const startApprovalContinuation = vi.fn();
    container.registerInstance(AIRunService, {
      decideToolCall,
      getConversationSnapshot,
      startApprovalContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'approval.decide',
          conversationId: 'conversation-1',
          runId: 'run-1',
          approvalId: 'approval-1',
          decision: 'approved',
          clientCommandId: 'cmd-3',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(decideToolCall).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      runId: 'run-1',
      toolCallId: 'approval-1',
      userId: USER.id,
      clientCommandId: 'cmd-3',
      decision: 'approved',
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'approval.updated',
        conversationId: 'conversation-1',
        runId: 'run-1',
        approval: toolCall,
        duplicate: false,
      })
    );
    expect(startApprovalContinuation).toHaveBeenCalledWith(USER, {
      conversationId: 'conversation-1',
      runId: 'run-1',
      toolCall,
      approved: true,
    });
  });

  it('starts an approval continuation even when the follow-up snapshot fails', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const toolCall = {
      id: 'approval-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'approved',
      decision: 'approved',
    };
    const startApprovalContinuation = vi.fn();
    container.registerInstance(AIRunService, {
      decideToolCall: vi.fn().mockResolvedValue({ toolCall, duplicate: false }),
      getConversationSnapshot: vi.fn().mockRejectedValue(new Error('snapshot unavailable')),
      startApprovalContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'approval.decide',
          conversationId: 'conversation-1',
          runId: 'run-1',
          approvalId: 'approval-1',
          decision: 'approved',
          clientCommandId: 'cmd-snapshot-failure',
        }),
      }),
      ws as any
    );
    await vi.waitFor(() => expect(startApprovalContinuation).toHaveBeenCalledOnce());

    const sentMessages = vi.mocked(ws.send).mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(sentMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'command.ack', clientCommandId: 'cmd-snapshot-failure' }),
        expect.objectContaining({ type: 'approval.updated', approval: toolCall }),
      ])
    );
    expect(sentMessages).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'command.error' })]));
    handlers.onClose(new Event('close'), ws as any);
  });

  it('retries credential continuation for an idempotent duplicate decision', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const challenge = {
      id: 'challenge-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'authorized',
    };
    const resolveCredentialChallenge = vi
      .fn()
      .mockResolvedValue({ challenge, additionalChallenges: [], duplicate: true });
    const startCredentialContinuation = vi.fn();
    container.registerInstance(AIRunService, {
      resolveCredentialChallenge,
      getConversationSnapshot: vi.fn().mockResolvedValue(createSnapshot(null)),
      startCredentialContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'credential.resolve',
          conversationId: 'conversation-1',
          runId: 'run-1',
          challengeId: 'challenge-1',
          decision: 'authorized',
          clientCommandId: 'cmd-credential-retry',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(startCredentialContinuation).toHaveBeenCalledWith(USER, {
      conversationId: 'conversation-1',
      runId: 'run-1',
      challenge,
      authorized: true,
    });
  });

  it('resumes all waiting runs after one GitLab authorization', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const challenge = {
      id: 'challenge-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'authorized',
    };
    const additionalChallenge = {
      id: 'challenge-2',
      runId: 'run-2',
      conversationId: 'conversation-2',
      status: 'authorized',
    };
    const resolveCredentialChallenge = vi.fn().mockResolvedValue({
      challenge,
      additionalChallenges: [additionalChallenge],
      duplicate: false,
    });
    const startCredentialContinuation = vi.fn();
    container.registerInstance(AIRunService, {
      resolveCredentialChallenge,
      getConversationSnapshot: vi.fn().mockResolvedValue(createSnapshot(null)),
      startCredentialContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'credential.resolve',
          conversationId: 'conversation-1',
          runId: 'run-1',
          challengeId: 'challenge-1',
          decision: 'authorized',
          clientCommandId: 'cmd-credential-all',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(startCredentialContinuation).toHaveBeenCalledTimes(2);
    expect(startCredentialContinuation).toHaveBeenNthCalledWith(2, USER, {
      conversationId: 'conversation-2',
      runId: 'run-2',
      challenge: additionalChallenge,
      authorized: true,
    });
  });

  it('routes question answers through the backend run service', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const question = {
      id: 'question-1',
      runId: 'run-1',
      conversationId: 'conversation-1',
      question: 'Which node?',
      status: 'answered',
      answer: 'node-1',
    };
    const answerQuestion = vi.fn().mockResolvedValue({ question, duplicate: false, remainingPendingQuestions: [] });
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(null));
    const startQuestionContinuation = vi.fn();
    container.registerInstance(AIRunService, {
      answerQuestion,
      getConversationSnapshot,
      startQuestionContinuation,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'question.answer',
          conversationId: 'conversation-1',
          runId: 'run-1',
          questionId: 'question-1',
          answer: 'node-1',
          clientCommandId: 'cmd-4',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(answerQuestion).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      runId: 'run-1',
      questionId: 'question-1',
      userId: USER.id,
      clientCommandId: 'cmd-4',
      answer: 'node-1',
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'question.answered',
        conversationId: 'conversation-1',
        runId: 'run-1',
        question,
        duplicate: false,
      })
    );
    expect(startQuestionContinuation).toHaveBeenCalledWith(USER, {
      conversationId: 'conversation-1',
      runId: 'run-1',
      question,
    });
  });

  it('stops a backend-owned run idempotently', async () => {
    const { ws, handlers } = await openAuthenticatedWs();
    const stoppedRun = {
      id: 'run-1',
      conversationId: 'conversation-1',
      userId: USER.id,
      status: 'stopped',
    };
    const stopRun = vi.fn().mockResolvedValue({ run: stoppedRun, duplicate: true });
    const getConversationSnapshot = vi.fn().mockResolvedValue(createSnapshot(null));
    container.registerInstance(AIRunService, {
      stopRun,
      getConversationSnapshot,
    } as unknown as AIRunService);

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'run.stop',
          conversationId: 'conversation-1',
          runId: 'run-1',
          clientCommandId: 'cmd-5',
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(stopRun).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      runId: 'run-1',
      userId: USER.id,
    });
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'run.status_changed',
        conversationId: 'conversation-1',
        run: stoppedRun,
        revision: 7,
      })
    );
  });

  it('rejects removed legacy websocket commands', async () => {
    const { ws, handlers } = await openAuthenticatedWs();

    await handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'chat',
          requestId: 'legacy-request',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
      ws as any
    );
    handlers.onClose(new Event('close'), ws as any);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command.error',
        commandType: 'chat',
        clientCommandId: 'legacy-request',
        code: 'AI_UNKNOWN_COMMAND',
        message: 'Unknown AI websocket command',
        statusCode: 400,
      })
    );
  });
});
