import { describe, expect, it, vi } from 'vitest';
import { AIConversationSearchService } from './ai-conversation-search.service.js';

describe('AIConversationSearchService best-effort indexing', () => {
  it('does not throw when a lifecycle index rebuild fails', async () => {
    const findFirst = vi.fn().mockRejectedValue(new Error('search index unavailable'));
    const service = new AIConversationSearchService({
      query: {
        aiConversations: {
          findFirst,
        },
      },
    } as never);

    expect(() => service.rebuildConversationIndexBestEffort('user-1', 'conversation-1')).not.toThrow();

    await vi.waitFor(() => {
      expect(findFirst).toHaveBeenCalled();
    });
  });

  it('excludes the current conversation from chat search', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      queryDocuments: (
        conditions: unknown[],
        matchedBy: string,
        baseScore: number,
        limit: number
      ) => Promise<unknown[]>;
      fuzzyDocuments: (conditions: unknown[], normalizedQuery: string, limit: number) => Promise<unknown[]>;
      groupConversationMatches: (rows: unknown[], limit: number) => Promise<unknown[]>;
      auditRetrieval: (userId: string, input: unknown) => Promise<void>;
      getOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      resolveScope: (userId: string, currentConversationId: string | null, scope: unknown) => Promise<unknown>;
    };
    const queryDocuments = vi.spyOn(internals, 'queryDocuments').mockResolvedValue([]);
    vi.spyOn(internals, 'fuzzyDocuments').mockResolvedValue([]);
    vi.spyOn(internals, 'groupConversationMatches').mockResolvedValue([]);
    vi.spyOn(internals, 'auditRetrieval').mockResolvedValue(undefined);
    vi.spyOn(service, 'backfillMissingIndexes').mockResolvedValue(0);
    vi.spyOn(internals, 'getOwnedConversation').mockResolvedValue({
      id: 'conversation-current',
      folderId: null,
    });
    vi.spyOn(internals, 'resolveScope').mockResolvedValue({ type: 'no_project' });

    await service.searchChats('user-1', {
      query: 'certificate renewal',
      currentConversationId: 'conversation-current',
      scope: { type: 'no_project' },
    });

    expect(queryDocuments).toHaveBeenCalled();
    const firstConditions = queryDocuments.mock.calls[0][0] as unknown[];
    expect(firstConditions).toHaveLength(4);
  });

  it('inserts rebuilt search documents in bounded batches', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const tx = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      insert: vi.fn(() => ({ values })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
    };
    const service = new AIConversationSearchService(db as never);
    const internals = service as unknown as {
      getOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      loadToolCallRows: (conversationId: string) => Promise<unknown[]>;
    };
    vi.spyOn(internals, 'getOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      userId: 'user-1',
      folderId: null,
      title: 'Docker troubleshooting',
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue(
      Array.from({ length: 160 }, (_, index) => ({
        id: `message-${index}`,
        sequence: index,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `docker compose diagnostic message ${index}`,
        uiMessage: {},
        toolCalls: null,
        toolName: null,
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date(1_782_000_000_000 + index),
      }))
    );
    vi.spyOn(internals, 'loadToolCallRows').mockResolvedValue([]);

    await service.rebuildConversationIndex('user-1', 'conversation-1');

    expect(values.mock.calls.length).toBeGreaterThan(1);
    expect(values.mock.calls.every(([batch]) => Array.isArray(batch) && batch.length <= 100)).toBe(true);
  });

  it('does not index raw tool payloads from messages or run records', async () => {
    const inserted: unknown[][] = [];
    const values = vi.fn(async (batch: unknown[]) => {
      inserted.push(batch);
    });
    const tx = {
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      insert: vi.fn(() => ({ values })),
    };
    const service = new AIConversationSearchService({
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)),
    } as never);
    const internals = service as unknown as {
      getOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      loadToolCallRows: (conversationId: string) => Promise<unknown[]>;
    };
    vi.spyOn(internals, 'getOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      userId: 'user-1',
      folderId: null,
      title: 'Database maintenance',
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      {
        id: 'message-1',
        sequence: 1,
        role: 'assistant',
        content: 'I checked the database connection.',
        uiMessage: {},
        toolCalls: [{ name: 'manage_database_connection', arguments: { password: 'SUPERSECRET_DB_PASSWORD' } }],
        toolName: 'manage_database_connection',
        toolArgsCompact: { password: 'SUPERSECRET_DB_PASSWORD' },
        toolResultRaw: { privateKey: 'SUPERSECRET_PRIVATE_KEY' },
        toolResultCompact: { dsn: 'postgres://SUPERSECRET_DB_PASSWORD@example.test/db' },
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
      },
      {
        id: 'message-2',
        sequence: 2,
        role: 'tool',
        content: '{"password":"SUPERSECRET_TOOL_MESSAGE"}',
        uiMessage: { content: '{"password":"SUPERSECRET_TOOL_UI"}' },
        toolCalls: null,
        toolName: 'manage_database_connection',
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:02:00.000Z'),
      },
    ]);
    vi.spyOn(internals, 'loadToolCallRows').mockResolvedValue([
      {
        id: 'tool-call-row-1',
        toolCallId: 'tool-call-1',
        toolName: 'manage_database_connection',
        toolArgs: { password: 'SUPERSECRET_DB_PASSWORD' },
        result: { privateKey: 'SUPERSECRET_PRIVATE_KEY' },
        error: null,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
        completedAt: new Date('2026-06-26T10:02:00.000Z'),
      },
    ]);

    await service.rebuildConversationIndex('user-1', 'conversation-1');

    const indexedText = inserted
      .flat()
      .map((document) => (document as { text: string }).text)
      .join('\n');
    expect(indexedText).toContain('manage_database_connection');
    expect(indexedText).toContain('tool_result');
    expect(indexedText).not.toContain('SUPERSECRET_DB_PASSWORD');
    expect(indexedText).not.toContain('SUPERSECRET_PRIVATE_KEY');
    expect(indexedText).not.toContain('SUPERSECRET_TOOL_MESSAGE');
    expect(indexedText).not.toContain('SUPERSECRET_TOOL_UI');
  });

  it('searches inside a chat from raw rows without rebuilding the index', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      requireOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      loadToolCallRows: (conversationId: string) => Promise<unknown[]>;
      lastUserMessageAtMany: (conversationIds: string[]) => Promise<Map<string, Date>>;
      auditRetrieval: (userId: string, input: unknown) => Promise<void>;
    };
    vi.spyOn(internals, 'requireOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      folderId: null,
      title: 'Docker troubleshooting',
      createdAt: new Date('2026-06-26T10:00:00.000Z'),
      updatedAt: new Date('2026-06-26T10:30:00.000Z'),
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      {
        id: 'message-1',
        sequence: 1,
        role: 'user',
        content: 'Please inspect docker compose logs',
        uiMessage: {},
        toolCalls: null,
        toolName: null,
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
      },
    ]);
    vi.spyOn(internals, 'loadToolCallRows').mockResolvedValue([]);
    vi.spyOn(internals, 'lastUserMessageAtMany').mockResolvedValue(
      new Map([['conversation-1', new Date('2026-06-26T10:01:00.000Z')]])
    );
    vi.spyOn(internals, 'auditRetrieval').mockResolvedValue(undefined);
    const rebuild = vi.spyOn(service, 'rebuildConversationIndex').mockRejectedValue(new Error('index failed'));

    const result = await service.findInChat('user-1', {
      conversationId: 'conversation-1',
      query: 'docker',
      limit: 10,
    });

    expect(rebuild).not.toHaveBeenCalled();
    expect(result.matches).toContainEqual(
      expect.objectContaining({
        messageId: 'message-1',
        role: 'user',
        matchedBy: 'phrase',
      })
    );
  });

  it('searches only non-sensitive messages before the latest compaction boundary', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      requireOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      auditRetrieval: (userId: string, input: unknown) => Promise<void>;
    };
    vi.spyOn(internals, 'requireOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      folderId: null,
      title: 'Compacted deploy',
      createdAt: new Date('2026-06-26T10:00:00.000Z'),
      updatedAt: new Date('2026-06-26T11:00:00.000Z'),
    });
    const row = (overrides: Record<string, unknown>) => ({
      id: 'message',
      sequence: 0,
      role: 'user',
      content: '',
      uiMessage: {},
      toolCalls: null,
      toolName: null,
      toolArgsCompact: null,
      toolResultRaw: null,
      toolResultCompact: null,
      isSensitive: false,
      createdAt: new Date('2026-06-26T10:00:00.000Z'),
      ...overrides,
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      row({ id: 'old-1', sequence: 1, content: 'The exact deployment tag is release-7f19.' }),
      row({ id: 'secret-1', sequence: 2, content: 'release-7f19 private token', isSensitive: true }),
      row({ id: 'boundary-1', sequence: 3, role: 'assistant', content: 'Older response' }),
      row({
        id: 'marker-1',
        sequence: 4,
        role: 'system',
        content: 'lossy summary',
        uiMessage: { compactMarker: true, compactEpoch: 2, compactBoundaryMessageId: 'boundary-1' },
      }),
      row({ id: 'new-1', sequence: 5, content: 'release-7f19 appeared after compaction too' }),
    ]);
    vi.spyOn(internals, 'auditRetrieval').mockResolvedValue(undefined);

    const result = await service.searchCompactedHistory('user-1', {
      conversationId: 'conversation-1',
      query: 'release-7f19',
      limit: 10,
    });

    expect(result.compacted).toBe(true);
    expect(result.compactEpoch).toBe(2);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.match).toMatchObject({ messageId: 'old-1', role: 'user' });
    expect(JSON.stringify(result.results)).not.toContain('private token');
    expect(JSON.stringify(result.results)).not.toContain('appeared after compaction');
    expect(JSON.stringify(result.results)).not.toContain('lossy summary');
  });

  it('does not match raw tool payloads when searching inside a chat', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      requireOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      loadToolCallRows: (conversationId: string) => Promise<unknown[]>;
      lastUserMessageAtMany: (conversationIds: string[]) => Promise<Map<string, Date>>;
      auditRetrieval: (userId: string, input: unknown) => Promise<void>;
    };
    vi.spyOn(internals, 'requireOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      folderId: null,
      title: 'Database troubleshooting',
      createdAt: new Date('2026-06-26T10:00:00.000Z'),
      updatedAt: new Date('2026-06-26T10:30:00.000Z'),
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      {
        id: 'message-1',
        sequence: 1,
        role: 'tool',
        content: '{"password":"SUPERSECRET_DB_PASSWORD"}',
        uiMessage: { content: '{"password":"SUPERSECRET_TOOL_UI"}' },
        toolCalls: null,
        toolName: 'manage_database_connection',
        toolArgsCompact: { password: 'SUPERSECRET_DB_PASSWORD' },
        toolResultRaw: { privateKey: 'SUPERSECRET_PRIVATE_KEY' },
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
      },
    ]);
    vi.spyOn(internals, 'loadToolCallRows').mockResolvedValue([
      {
        id: 'tool-call-row-1',
        toolCallId: 'tool-call-1',
        toolName: 'manage_database_connection',
        toolArgs: { password: 'SUPERSECRET_DB_PASSWORD' },
        result: { privateKey: 'SUPERSECRET_PRIVATE_KEY' },
        error: null,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
        completedAt: new Date('2026-06-26T10:02:00.000Z'),
      },
    ]);
    vi.spyOn(internals, 'lastUserMessageAtMany').mockResolvedValue(
      new Map([['conversation-1', new Date('2026-06-26T10:01:00.000Z')]])
    );
    vi.spyOn(internals, 'auditRetrieval').mockResolvedValue(undefined);

    const result = await service.findInChat('user-1', {
      conversationId: 'conversation-1',
      query: 'SUPERSECRET_DB_PASSWORD',
      limit: 10,
    });

    expect(result.matches).toEqual([]);
  });

  it('does not return raw tool message content from chat slices', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      requireOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
      auditRetrieval: (userId: string, input: unknown) => Promise<void>;
    };
    vi.spyOn(internals, 'requireOwnedConversation').mockResolvedValue({
      id: 'conversation-1',
      folderId: null,
      title: 'Database troubleshooting',
    });
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      {
        id: 'message-1',
        sequence: 1,
        role: 'tool',
        content: '{"password":"SUPERSECRET_DB_PASSWORD"}',
        uiMessage: { content: '{"password":"SUPERSECRET_TOOL_UI"}' },
        toolCalls: null,
        toolName: 'manage_database_connection',
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
      },
    ]);
    vi.spyOn(internals, 'auditRetrieval').mockResolvedValue(undefined);

    const result = await service.readChatSlice('user-1', {
      conversationId: 'conversation-1',
      mode: 'latest',
      limit: 10,
    });

    expect(result.messages).toEqual([
      expect.objectContaining({
        messageId: 'message-1',
        role: 'tool',
        content: '',
        toolName: 'manage_database_connection',
      }),
    ]);
  });

  it('adds lightweight tail context for up to three recent project chats', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      getOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      listProjectPointers: (userId: string, input: unknown) => Promise<unknown>;
      recentChatsForPrompt: (
        userId: string,
        projectId: string | null,
        excludeConversationId: string | null
      ) => Promise<
        Array<{
          conversationId: string;
          projectId: string | null;
          title: string;
          lastUserMessageAt: string | null;
        }>
      >;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
    };
    vi.spyOn(internals, 'getOwnedConversation').mockResolvedValue({
      id: 'conversation-current',
      folderId: 'project-1',
    });
    vi.spyOn(internals, 'listProjectPointers').mockResolvedValue({ projects: [], nextCursor: null });
    const recentChats = Array.from({ length: 4 }, (_, index) => ({
      conversationId: `conversation-${index + 1}`,
      projectId: 'project-1',
      title: `Chat ${index + 1}`,
      lastUserMessageAt: `2026-06-26T10:0${index}:00.000Z`,
    }));
    const recentChatsForPrompt = vi.spyOn(internals, 'recentChatsForPrompt').mockResolvedValue(recentChats);
    vi.spyOn(internals, 'loadMessageRows').mockImplementation(async (conversationId: string) =>
      Array.from({ length: 5 }, (_, index) => ({
        id: `${conversationId}-message-${index}`,
        sequence: index,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${conversationId} tail message ${index}`,
        uiMessage: {},
        toolCalls: null,
        toolName: null,
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date(`2026-06-26T10:0${index}:00.000Z`),
      }))
    );

    const pointers = await service.getPromptPointers('user-1', 'conversation-current');

    expect(recentChatsForPrompt).toHaveBeenCalledWith('user-1', 'project-1', 'conversation-current');
    expect(pointers.recentChats).toHaveLength(4);
    expect(pointers.projectRecentChatContexts).toHaveLength(3);
    expect(pointers.projectRecentChatContexts.map((context) => context.conversationId)).toEqual([
      'conversation-1',
      'conversation-2',
      'conversation-3',
    ]);
    expect(pointers.projectRecentChatContexts[0].messages).toHaveLength(4);
    expect(pointers.projectRecentChatContexts[0].messages[0].content).toBe('conversation-1 tail message 1');
  });

  it('does not include raw tool message content in prompt tail context', async () => {
    const service = new AIConversationSearchService({} as never);
    const internals = service as unknown as {
      getOwnedConversation: (userId: string, conversationId: string) => Promise<unknown>;
      listProjectPointers: (userId: string, input: unknown) => Promise<unknown>;
      recentChatsForPrompt: (
        userId: string,
        projectId: string | null,
        excludeConversationId: string | null
      ) => Promise<
        Array<{
          conversationId: string;
          projectId: string | null;
          title: string;
          lastUserMessageAt: string | null;
        }>
      >;
      loadMessageRows: (conversationId: string) => Promise<unknown[]>;
    };
    vi.spyOn(internals, 'getOwnedConversation').mockResolvedValue({
      id: 'conversation-current',
      folderId: 'project-1',
    });
    vi.spyOn(internals, 'listProjectPointers').mockResolvedValue({ projects: [], nextCursor: null });
    vi.spyOn(internals, 'recentChatsForPrompt').mockResolvedValue([
      {
        conversationId: 'conversation-1',
        projectId: 'project-1',
        title: 'Database troubleshooting',
        lastUserMessageAt: '2026-06-26T10:01:00.000Z',
      },
    ]);
    vi.spyOn(internals, 'loadMessageRows').mockResolvedValue([
      {
        id: 'message-1',
        sequence: 1,
        role: 'tool',
        content: '{"password":"SUPERSECRET_DB_PASSWORD"}',
        uiMessage: { content: '{"password":"SUPERSECRET_TOOL_UI"}' },
        toolCalls: null,
        toolName: 'manage_database_connection',
        toolArgsCompact: null,
        toolResultRaw: null,
        toolResultCompact: null,
        isSensitive: false,
        createdAt: new Date('2026-06-26T10:01:00.000Z'),
      },
    ]);

    const pointers = await service.getPromptPointers('user-1', 'conversation-current');

    expect(pointers.projectRecentChatContexts[0].messages).toEqual([
      expect.objectContaining({
        role: 'tool',
        content: '',
        toolName: 'manage_database_connection',
      }),
    ]);
  });
});
