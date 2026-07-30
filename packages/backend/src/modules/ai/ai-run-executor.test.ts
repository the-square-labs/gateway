import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { User } from '@/types.js';
import { AIService } from './ai.service.js';
import type { ChatMessage, WSServerMessage } from './ai.types.js';
import { AIRunExecutor } from './ai-run-executor.js';

const USER: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

async function* streamEvents(events: WSServerMessage[]) {
  for (const event of events) yield event;
}

function createExecutorHarness(
  events: WSServerMessage[],
  options: { messageRows?: Array<{ uiMessage: Record<string, unknown> }> } = {}
) {
  const streamChat = vi.fn((_user: User, _messages: ChatMessage[]) => streamEvents(events));
  const selectQueue = [
    [
      {
        id: 'run-1',
        conversationId: 'conversation-1',
        userId: USER.id,
        status: 'queued',
        activeMessageId: 'user-message-1',
        clientCommandId: 'cmd-1',
        assistantDraftContent: null,
        error: null,
        createdAt: new Date('2026-06-26T10:00:00.000Z'),
        updatedAt: new Date('2026-06-26T10:00:00.000Z'),
      },
    ],
    [{ id: 'conversation-1', userId: USER.id, title: 'Runtime chat', lastContext: null }],
    options.messageRows ?? [{ uiMessage: { role: 'user', content: 'hello' } }],
    [],
  ];
  let orderByCalls = 0;
  const selectLimit = vi.fn(async () => selectQueue.shift() ?? []);
  const selectOrderBy = vi.fn(() => {
    orderByCalls += 1;
    return orderByCalls === 1 ? Promise.resolve(selectQueue.shift() ?? []) : { limit: selectLimit };
  });
  const selectWhere = vi.fn(() => ({ limit: selectLimit, orderBy: selectOrderBy }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  let insertId = 0;
  const insertValues = vi.fn((values: Record<string, unknown>) => {
    const returning = vi.fn(async () =>
      values.provider === 'gitlab'
        ? [
            {
              id: 'challenge-1',
              ...values,
              status: 'pending',
              decisionClientCommandId: null,
              resolvedAt: null,
              createdAt: new Date('2026-06-26T10:00:00.000Z'),
              updatedAt: new Date('2026-06-26T10:00:00.000Z'),
            },
          ]
        : [{ id: `assistant-message-${++insertId}` }]
    );
    return {
      returning,
      onConflictDoUpdate: vi.fn(() => ({ returning })),
    };
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const publishConversationChanged = vi.fn();
  const publishAssistantDelta = vi.fn();
  const publishAssistantCommentDelta = vi.fn();
  const publishAssistantCommentDone = vi.fn();
  const publishCredentialChallenge = vi.fn();
  const executor = new AIRunExecutor(
    { select, insert, update } as never,
    publishConversationChanged,
    publishAssistantDelta,
    publishAssistantCommentDelta,
    publishAssistantCommentDone,
    undefined,
    publishCredentialChallenge
  );

  container.registerInstance(AIService, {
    shouldAutoCompactContext: vi.fn().mockResolvedValue(false),
    streamChat,
  } as unknown as AIService);

  return {
    executor,
    streamChat,
    insertValues,
    updateSet,
    publishConversationChanged,
    publishAssistantDelta,
    publishAssistantCommentDelta,
    publishCredentialChallenge,
  };
}

async function executeRun(executor: AIRunExecutor): Promise<void> {
  await (executor as unknown as { executeRun(user: User, runId: string): Promise<void> }).executeRun(USER, 'run-1');
}

afterEach(() => {
  container.reset();
});

describe('AIRunExecutor live assistant draft streaming', () => {
  it('publishes a persisted credential challenge after moving the run into the waiting state', async () => {
    const { executor, publishCredentialChallenge, publishConversationChanged } = createExecutorHarness([
      {
        type: 'credential_authorization_required',
        requestId: 'request-1',
        id: 'tool-1',
        name: 'gitlab_list_projects',
        provider: 'gitlab',
        connectorId: '22222222-2222-4222-8222-222222222222',
        arguments: { connectorId: '22222222-2222-4222-8222-222222222222' },
      },
    ]);

    await executeRun(executor);

    expect(publishCredentialChallenge).toHaveBeenCalledWith(
      USER.id,
      'conversation-1',
      'run-1',
      expect.objectContaining({
        id: 'challenge-1',
        runId: 'run-1',
        connectorId: '22222222-2222-4222-8222-222222222222',
        toolName: 'gitlab_list_projects',
        status: 'pending',
      })
    );
    expect(publishConversationChanged).toHaveBeenCalledWith(USER.id, 'conversation-1');
  });

  it('releases the credential continuation lock when startup fails before resume execution', async () => {
    const executor = new AIRunExecutor({} as never, vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const executeCredentialContinuation = vi.fn().mockRejectedValue(new Error('checkpoint unavailable'));
    (
      executor as unknown as {
        executeCredentialContinuation: typeof executeCredentialContinuation;
      }
    ).executeCredentialContinuation = executeCredentialContinuation;
    const input = {
      conversationId: 'conversation-1',
      runId: 'run-1',
      challenge: {
        id: 'challenge-1',
        runId: 'run-1',
        conversationId: 'conversation-1',
        userId: USER.id,
        provider: 'gitlab' as const,
        connectorId: 'connector-1',
        toolCallId: 'tool-call-1',
        toolName: 'gitlab_read_file',
        status: 'authorized' as const,
        decisionClientCommandId: 'command-1',
        resolvedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      authorized: true,
    };

    executor.startCredentialContinuation(USER, input);
    await vi.waitFor(() => expect(executeCredentialContinuation).toHaveBeenCalledTimes(1));
    executor.startCredentialContinuation(USER, input);
    await vi.waitFor(() => expect(executeCredentialContinuation).toHaveBeenCalledTimes(2));
  });

  it('emits lightweight deltas without per-delta DB draft writes or full snapshot publishes', async () => {
    const harness = createExecutorHarness([
      { type: 'text_delta', requestId: 'request-1', content: 'Hel' },
      { type: 'text_delta', requestId: 'request-1', content: 'lo' },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.publishAssistantDelta).toHaveBeenCalledTimes(2);
    expect(harness.publishAssistantDelta).toHaveBeenNthCalledWith(1, USER.id, 'conversation-1', 'run-1', 'Hel', 1);
    expect(harness.publishAssistantDelta).toHaveBeenNthCalledWith(2, USER.id, 'conversation-1', 'run-1', 'lo', 2);
    expect(harness.publishConversationChanged).toHaveBeenCalledTimes(2);
    expect(harness.updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ assistantDraftContent: 'Hel' }));
    expect(harness.updateSet).not.toHaveBeenCalledWith(expect.objectContaining({ assistantDraftContent: 'Hello' }));
  });

  it('sends compact summary plus preserved tail to the model while keeping UI order untouched', async () => {
    const harness = createExecutorHarness([{ type: 'done', requestId: 'request-1' }], {
      messageRows: [
        { uiMessage: { role: 'user', content: 'old user' } },
        { uiMessage: { role: 'assistant', content: 'old assistant' } },
        { uiMessage: { role: 'user', content: 'tail user' } },
        { uiMessage: { role: 'assistant', content: 'tail assistant' } },
        {
          uiMessage: {
            role: 'assistant',
            content: 'summary of older context',
            compactMarker: true,
            compactTailMessageCount: 2,
          },
        },
        { uiMessage: { role: 'user', content: 'new user after compact' } },
      ],
    });

    await executeRun(harness.executor);

    const messages = harness.streamChat.mock.calls[0]?.[1];
    expect(messages?.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'summary of older context'],
      ['user', 'tail user'],
      ['assistant', 'tail assistant'],
      ['user', 'new user after compact'],
    ]);
  });

  it('flushes accumulated text to an assistant message on done', async () => {
    const harness = createExecutorHarness([
      { type: 'text_delta', requestId: 'request-1', content: 'Hello' },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Hello',
        uiMessage: expect.objectContaining({ role: 'assistant', content: 'Hello' }),
      })
    );
  });

  it('persists assistant comments as standalone messages while keeping the run active', async () => {
    const harness = createExecutorHarness([
      { type: 'assistant_comment', requestId: 'request-1', content: 'Still checking the nodes.' },
      { type: 'text_delta', requestId: 'request-1', content: 'Done.' },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.publishAssistantDelta).not.toHaveBeenCalledWith(
      USER.id,
      'conversation-1',
      'run-1',
      'Still checking the nodes.',
      expect.any(Number)
    );
    expect(harness.publishAssistantCommentDelta).toHaveBeenCalledWith(
      USER.id,
      'conversation-1',
      'run-1',
      'Still checking the nodes.',
      1
    );
    expect(harness.publishAssistantDelta).toHaveBeenCalledWith(USER.id, 'conversation-1', 'run-1', 'Done.', 2);
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Still checking the nodes.',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Done.',
      })
    );
    expect(harness.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Still checking the nodes.Done.',
      })
    );
  });

  it('closes streamed assistant text before the first tool boundary', async () => {
    const harness = createExecutorHarness([
      { type: 'text_delta', requestId: 'request-1', content: 'Checking resources.' },
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        arguments: {},
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        result: { data: [] },
      },
      { type: 'text_delta', requestId: 'request-1', content: 'Done.' },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Checking resources.',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '',
        uiMessage: expect.objectContaining({ toolGroupBoundary: true }),
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Done.',
      })
    );
    expect(harness.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Checking resources.Done.',
      })
    );
  });

  it('starts a new tool boundary after streamed text between tool batches', async () => {
    const harness = createExecutorHarness([
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        arguments: {},
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        result: { data: [] },
      },
      { type: 'text_delta', requestId: 'request-1', content: 'Continuing with remaining categories.' },
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-2',
        name: 'list_nodes',
        arguments: {},
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-2',
        name: 'list_nodes',
        result: { data: [] },
      },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-1',
        toolName: 'list_databases',
        assistantMessageId: 'assistant-message-1',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Continuing with remaining categories.',
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-2',
        toolName: 'list_nodes',
        assistantMessageId: 'assistant-message-3',
      })
    );
    expect(harness.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-2',
        assistantMessageId: 'assistant-message-1',
      })
    );
  });

  it('flushes accumulated text before waiting for tool approval', async () => {
    const harness = createExecutorHarness([
      { type: 'text_delta', requestId: 'request-1', content: 'Need approval' },
      {
        type: 'tool_approval_required',
        requestId: 'request-1',
        id: 'call-1',
        name: 'pull_docker_image',
        arguments: { imageRef: 'redis:latest' },
      },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Need approval',
      })
    );
    expect(harness.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'waiting_for_approval' }));
  });

  it('flushes accumulated text before marking a run failed', async () => {
    const harness = createExecutorHarness([
      { type: 'text_delta', requestId: 'request-1', content: 'Partial answer' },
      { type: 'error', requestId: 'request-1', message: 'provider failed' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: 'Partial answer',
      })
    );
    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'provider failed' })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '**Error:** provider failed',
        uiMessage: expect.objectContaining({
          localOnly: true,
          runError: true,
          runId: 'run-1',
        }),
      })
    );
  });

  it('persists a hidden conversation-ended marker after end_conversation', async () => {
    const harness = createExecutorHarness([
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-end',
        name: 'end_conversation',
        arguments: { reason: 'I can only help with Gateway infrastructure.' },
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-end',
        name: 'end_conversation',
        result: { ended: true, reason: 'I can only help with Gateway infrastructure.' },
      },
      {
        type: 'conversation_ended',
        requestId: 'request-1',
        reason: 'I can only help with Gateway infrastructure.',
      },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '',
        uiMessage: expect.objectContaining({
          role: 'assistant',
          content: '',
          conversationStatus: 'ended',
          blockReason: 'I can only help with Gateway infrastructure.',
        }),
      })
    );
    expect(harness.updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('anchors runtime tool calls to a dedicated assistant tool boundary', async () => {
    const harness = createExecutorHarness([
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        arguments: {},
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-1',
        name: 'list_databases',
        result: { data: [] },
      },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        role: 'assistant',
        content: '',
        uiMessage: expect.objectContaining({ toolGroupBoundary: true }),
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'call-1',
        toolName: 'list_databases',
        assistantMessageId: 'assistant-message-1',
      })
    );
  });

  it('persists a redacted copy of one-time API token tool results', async () => {
    const harness = createExecutorHarness([
      {
        type: 'tool_call_start',
        requestId: 'request-1',
        id: 'call-1',
        name: 'manage_api_token',
        arguments: { operation: 'create', name: 'Deploy' },
      },
      {
        type: 'tool_result',
        requestId: 'request-1',
        id: 'call-1',
        name: 'manage_api_token',
        result: { id: 'token-1', name: 'Deploy', token: 'gw_secret' },
      },
      { type: 'done', requestId: 'request-1' },
    ]);

    await executeRun(harness.executor);

    expect(harness.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        result: { id: 'token-1', name: 'Deploy', token: '[REDACTED_ONE_TIME_SECRET]', tokenRedacted: true },
      })
    );
  });
});
