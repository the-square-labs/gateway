import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { aiRoutes } from './ai.routes.js';
import { AISandboxArtifactService } from './ai.sandbox-artifact.service.js';
import { AISettingsService } from './ai.settings.service.js';
import { AIConversationService } from './ai-conversation.service.js';
import { AIProviderRuntimeService } from './ai-provider-runtime.service.js';
import { AIRunService } from './ai-run.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['feat:ai:use', 'feat:ai:configure', 'ai:skills:manage'],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

function createDb(): DrizzleClient {
  return {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: USER.groupId,
            parentId: null,
            name: USER.groupName,
            scopes: USER.scopes,
          },
        ]),
      },
    },
  } as unknown as DrizzleClient;
}

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status);
    }
    throw error;
  });
  app.route('/api/ai', aiRoutes);
  return app;
}

function registerServices(aiSettings?: Partial<AISettingsService>) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, createDb());
  container.registerInstance(AISettingsService, {
    isEnabled: vi.fn().mockResolvedValue(true),
    getConfig: vi.fn().mockResolvedValue({
      providerType: 'openai_compatible',
      model: 'test-model',
      supportsImages: false,
      allowUserReasoningEffortSelection: false,
    }),
    ...aiSettings,
  } as unknown as AISettingsService);
}

afterEach(() => {
  container.reset();
});

describe('AI routes session-only authentication', () => {
  it('allows browser session users to query AI status', async () => {
    registerServices();

    const response = await createApp().request('/api/ai/status', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      providerType: 'openai_compatible',
      defaultModel: 'test-model',
      allowUserModelSelection: false,
      allowUserReasoningEffortSelection: false,
      reasoningEfforts: ['default', 'low', 'medium', 'high'],
      defaultReasoningEffort: 'default',
      supportsImages: false,
      models: [],
    });
  });

  it('rejects API tokens for AI routes', async () => {
    registerServices();
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({ user: USER, scopes: USER.scopes }),
    } as unknown as TokensService);

    const response = await createApp().request('/api/ai/status', {
      headers: { Authorization: 'Bearer gw_test_token' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      message: 'This endpoint requires browser session authentication.',
    });
  });

  it('loads conversations for the authenticated user', async () => {
    registerServices();
    const getConversation = vi.fn().mockResolvedValue({
      id: 'conversation-1',
      title: 'debug session',
      createdAt: new Date('2026-06-24T09:00:00Z'),
      updatedAt: new Date('2026-06-24T09:01:00Z'),
      folderId: null,
      messageCount: 1,
      messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    });
    container.registerInstance(AIConversationService, {
      getConversation,
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/conversations/conversation-1', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(getConversation).toHaveBeenCalledWith(USER.id, 'conversation-1');
    expect(await response.json()).toMatchObject({
      data: {
        id: 'conversation-1',
        title: 'debug session',
        messageCount: 1,
      },
    });
  });

  it('returns a bounded artifact page with the next-page cursor', async () => {
    registerServices();
    const listPageForUser = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'artifact-1',
          userId: USER.id,
          conversationId: 'conversation-1',
          sourceProcessId: 'process-1',
          sourcePath: 'result.txt',
          filename: 'result.txt',
          mediaType: 'text/plain',
          sizeBytes: 12,
          createdAt: '2026-08-13T10:00:00.000Z',
          downloadUrl: '/api/ai/sandbox/artifacts/artifact-1/download',
        },
      ],
      nextPage: 3,
    });
    container.registerInstance(AISandboxArtifactService, {
      listPageForUser,
    } as unknown as AISandboxArtifactService);
    container.registerInstance(AIConversationService, {
      listConversationTitles: vi.fn().mockResolvedValue({ 'conversation-1': 'Deploy app' }),
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/sandbox/artifacts?page=2&limit=10', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(200);
    expect(listPageForUser).toHaveBeenCalledWith(USER.id, 2, 10);
    expect(await response.json()).toMatchObject({
      data: [{ id: 'artifact-1', conversationTitle: 'Deploy app' }],
      nextPage: 3,
    });
  });

  it('returns 404 when restoring another user conversation', async () => {
    registerServices();
    container.registerInstance(AIConversationService, {
      getConversation: vi.fn().mockResolvedValue(null),
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/conversations/conversation-2', {
      headers: { Cookie: 'session_id=session-1' },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'Conversation not found' });
  });

  it('renames an owned conversation', async () => {
    registerServices();
    const renameConversation = vi.fn().mockResolvedValue({
      id: 'conversation-1',
      title: 'renamed chat',
      createdAt: new Date('2026-06-24T09:00:00Z'),
      updatedAt: new Date('2026-06-24T09:02:00Z'),
      folderId: null,
      messageCount: 1,
      messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    });
    container.registerInstance(AIConversationService, {
      renameConversation,
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/conversations/conversation-1', {
      method: 'PATCH',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed chat' }),
    });

    expect(response.status).toBe(200);
    expect(renameConversation).toHaveBeenCalledWith(USER.id, 'conversation-1', 'renamed chat');
    expect(await response.json()).toMatchObject({
      data: {
        id: 'conversation-1',
        title: 'renamed chat',
      },
    });
  });

  it('validates and persists a per-conversation model change', async () => {
    registerServices();
    const currentConversation = {
      id: 'conversation-1',
      title: 'debug session',
      model: 'model-a',
      reasoningEffort: 'high',
      messages: [],
    };
    const updatedConversation = {
      ...currentConversation,
      model: 'model-b',
      reasoningEffort: 'max',
    };
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce(currentConversation)
      .mockResolvedValueOnce(updatedConversation);
    const updateConversationProvider = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIConversationService, {
      getConversation,
    } as unknown as AIConversationService);
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({
        enabled: true,
        providerType: 'gateway_inference',
        defaultModel: 'model-a',
        allowUserModelSelection: true,
        supportsImages: false,
        models: [
          {
            id: 'model-a',
            displayName: 'Model A',
            reasoningEfforts: ['high'],
          },
          {
            id: 'model-b',
            displayName: 'Model B',
            reasoningEfforts: ['max'],
          },
        ],
      }),
    } as unknown as AIProviderRuntimeService);
    container.registerInstance(AIRunService, {
      updateConversationProvider,
    } as unknown as AIRunService);

    const response = await createApp().request('/api/ai/conversations/conversation-1/provider', {
      method: 'PATCH',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-b', reasoningEffort: 'max' }),
    });

    expect(response.status).toBe(200);
    expect(updateConversationProvider).toHaveBeenCalledWith({
      userId: USER.id,
      conversationId: 'conversation-1',
      model: 'model-b',
      reasoningEffort: 'max',
      modelDisplayName: 'Model B',
      previousModelDisplayName: 'Model A',
    });
    expect(await response.json()).toMatchObject({
      data: { id: 'conversation-1', model: 'model-b', reasoningEffort: 'max' },
    });
  });

  it('persists an allowed direct-provider reasoning override', async () => {
    registerServices();
    const currentConversation = {
      id: 'conversation-1',
      title: 'debug session',
      model: 'test-model',
      reasoningEffort: null,
      messages: [],
    };
    const updatedConversation = {
      ...currentConversation,
      reasoningEffort: 'high',
    };
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce(currentConversation)
      .mockResolvedValueOnce(updatedConversation);
    const updateConversationProvider = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIConversationService, {
      getConversation,
    } as unknown as AIConversationService);
    container.registerInstance(AIProviderRuntimeService, {
      statusForUser: vi.fn().mockResolvedValue({
        enabled: true,
        providerType: 'openai_compatible',
        defaultModel: 'test-model',
        allowUserModelSelection: false,
        allowUserReasoningEffortSelection: true,
        reasoningEfforts: ['default', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'default',
        supportsImages: false,
        models: [],
      }),
    } as unknown as AIProviderRuntimeService);
    container.registerInstance(AIRunService, {
      updateConversationProvider,
    } as unknown as AIRunService);

    const response = await createApp().request('/api/ai/conversations/conversation-1/provider', {
      method: 'PATCH',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', reasoningEffort: 'high' }),
    });

    expect(response.status).toBe(200);
    expect(updateConversationProvider).toHaveBeenCalledWith({
      userId: USER.id,
      conversationId: 'conversation-1',
      model: 'test-model',
      reasoningEffort: 'high',
      modelDisplayName: 'test-model',
      previousModelDisplayName: 'test-model',
    });
  });

  it('rolls conversations back to an owned user message', async () => {
    registerServices();
    const rollbackToMessage = vi.fn().mockResolvedValue({
      message: { id: 'message-1', role: 'user', content: 'hello' },
      conversation: {
        id: 'conversation-1',
        title: 'debug session',
        createdAt: new Date('2026-06-24T09:00:00Z'),
        updatedAt: new Date('2026-06-24T09:01:00Z'),
        folderId: null,
        messageCount: 0,
        messages: [],
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: null,
      },
    });
    const stopActiveRunForRollback = vi.fn().mockResolvedValue(null);
    container.registerInstance(AIRunService, { stopActiveRunForRollback } as unknown as AIRunService);
    container.registerInstance(AIConversationService, {
      rollbackToMessage,
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/conversations/conversation-1/rollback', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'message-1' }),
    });

    expect(response.status).toBe(200);
    expect(stopActiveRunForRollback).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId: USER.id,
    });
    expect(rollbackToMessage).toHaveBeenCalledWith(USER.id, 'conversation-1', 'message-1');
    expect(await response.json()).toMatchObject({
      data: {
        message: { id: 'message-1', role: 'user', content: 'hello' },
        conversation: { id: 'conversation-1', messages: [] },
      },
    });
  });

  it('stops the active run before rolling a conversation back to an owned user message', async () => {
    registerServices();
    const rollbackToMessage = vi.fn().mockResolvedValue({
      message: { id: 'message-1', role: 'user', content: 'hello' },
      conversation: {
        id: 'conversation-1',
        title: 'debug session',
        createdAt: new Date('2026-06-24T09:00:00Z'),
        updatedAt: new Date('2026-06-24T09:01:00Z'),
        folderId: null,
        messageCount: 0,
        messages: [],
        lastContext: null,
        discoveredToolsets: [],
        checkpoint: null,
      },
    });
    const stopActiveRunForRollback = vi.fn().mockResolvedValue({
      run: { id: 'run-1' },
      duplicate: false,
    });
    container.registerInstance(AIRunService, { stopActiveRunForRollback } as unknown as AIRunService);
    container.registerInstance(AIConversationService, {
      rollbackToMessage,
    } as unknown as AIConversationService);

    const response = await createApp().request('/api/ai/conversations/conversation-1/rollback', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 'message-1', activeRunId: 'run-1' }),
    });

    expect(response.status).toBe(200);
    expect(stopActiveRunForRollback).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId: USER.id,
    });
    expect(rollbackToMessage).toHaveBeenCalledWith(USER.id, 'conversation-1', 'message-1');
  });

  it('audits custom system prompt changes without storing raw prompt text', async () => {
    const auditLog = vi.fn().mockResolvedValue(true);
    const getConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'old private instruction' });
    const updateConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'new private instruction', model: 'gpt-5' });
    const getConfigForAdmin = vi.fn().mockResolvedValue({
      customSystemPrompt: 'new private instruction',
      model: 'gpt-5',
      hasApiKey: false,
      apiKeyLast4: '',
      hasWebSearchKey: false,
      webSearchApiKeyLast4: '',
    });
    registerServices({ getConfig, updateConfig, getConfigForAdmin });
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request('/api/ai/config', {
      method: 'PUT',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSystemPrompt: 'new private instruction', model: 'gpt-5' }),
    });

    expect(response.status).toBe(200);
    expect(updateConfig).toHaveBeenCalledWith({ customSystemPrompt: 'new private instruction', model: 'gpt-5' });
    expect(auditLog).toHaveBeenCalledTimes(2);
    expect(auditLog).toHaveBeenNthCalledWith(1, {
      userId: USER.id,
      action: 'ai.config.update',
      resourceType: 'ai-config',
      details: {
        changedFields: ['customSystemPrompt', 'model'],
        customSystemPromptChanged: true,
      },
    });
    expect(auditLog).toHaveBeenNthCalledWith(2, {
      userId: USER.id,
      action: 'ai.config.prompt.update',
      resourceType: 'ai-config',
      details: {
        old: {
          hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          length: 'old private instruction'.length,
          empty: false,
        },
        new: {
          hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          length: 'new private instruction'.length,
          empty: false,
        },
      },
    });
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('old private instruction');
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('new private instruction');
  });

  it('keeps fallback audit available when the generic prompt-change audit write fails', async () => {
    const auditLog = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const getConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'old private instruction' });
    const updateConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'new private instruction' });
    const getConfigForAdmin = vi.fn().mockResolvedValue({
      customSystemPrompt: 'new private instruction',
      hasApiKey: false,
      apiKeyLast4: '',
      hasWebSearchKey: false,
      webSearchApiKeyLast4: '',
    });
    registerServices({ getConfig, updateConfig, getConfigForAdmin });
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request('/api/ai/config', {
      method: 'PUT',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSystemPrompt: 'new private instruction' }),
    });

    expect(response.status).toBe(200);
    expect(auditLog).toHaveBeenCalledTimes(2);
    expect(auditLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'ai.config.prompt.update',
        resourceType: 'ai-config',
      }),
      { markRequest: false }
    );
  });

  it('does not audit custom system prompt updates when the prompt is unchanged', async () => {
    const auditLog = vi.fn().mockResolvedValue(true);
    const getConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'same instruction' });
    const updateConfig = vi.fn().mockResolvedValue({ customSystemPrompt: 'same instruction' });
    const getConfigForAdmin = vi.fn().mockResolvedValue({
      customSystemPrompt: 'same instruction',
      hasApiKey: false,
      apiKeyLast4: '',
      hasWebSearchKey: false,
      webSearchApiKeyLast4: '',
    });
    registerServices({ getConfig, updateConfig, getConfigForAdmin });
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const response = await createApp().request('/api/ai/config', {
      method: 'PUT',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSystemPrompt: 'same instruction' }),
    });

    expect(response.status).toBe(200);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('lists shared skills and audits user-skill creation without logging instructions', async () => {
    let storedSkills: unknown[] = [];
    const auditLog = vi.fn().mockResolvedValue(true);
    registerServices({
      getUserSkills: vi.fn(async () => storedSkills) as never,
      setUserSkills: vi.fn(async (skills) => {
        storedSkills = skills as unknown[];
      }) as never,
    });
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const listResponse = await createApp().request('/api/ai/skills', {
      headers: { Cookie: 'session_id=session-1' },
    });
    expect(listResponse.status).toBe(200);
    const listPayload = (await listResponse.json()) as { data: unknown[] };
    expect(listPayload.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'system', enabled: true })])
    );

    const createResponse = await createApp().request('/api/ai/skills', {
      method: 'POST',
      headers: { Cookie: 'session_id=session-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Production naming',
        description: 'Private shared naming policy',
        instructions: 'Use the private production naming convention.',
      }),
    });

    expect(createResponse.status).toBe(201);
    const createPayload = (await createResponse.json()) as { data: Record<string, unknown> };
    expect(createPayload.data).toMatchObject({
      name: 'Production naming',
      source: 'user',
      enabled: true,
    });
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'ai.skill.create',
        resourceType: 'ai-skill',
        details: expect.objectContaining({
          description: expect.objectContaining({ hash: expect.any(String) }),
          instructions: expect.objectContaining({ hash: expect.any(String) }),
        }),
      })
    );
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('Private shared naming policy');
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('private production naming convention');
  });
});
