import { describe, expect, it, vi } from 'vitest';
import { AIService } from './ai.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['ai:workspace:use'],
  isBlocked: false,
};

function createService(conversationSearchService: Record<string, unknown>) {
  return new AIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { log: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    conversationSearchService as never
  );
}

describe('AIService conversation retrieval tools', () => {
  it('routes read-only retrieval tools to the conversation search service', async () => {
    const conversationSearchService = {
      searchChats: vi.fn().mockResolvedValue({ results: [], appliedStrategies: [] }),
      findInChat: vi.fn().mockResolvedValue({ conversationId: 'conversation-2', matches: [] }),
      readChatSlice: vi.fn().mockResolvedValue({ conversationId: 'conversation-2', messages: [] }),
      listProjects: vi.fn().mockResolvedValue({ projects: [], nextCursor: null }),
    };
    const service = createService(conversationSearchService);

    await expect(
      service.executeTool(
        BASE_USER,
        'search_chats',
        { query: 'migration error', scope: { type: 'current_project' } },
        { conversationId: 'conversation-1' }
      )
    ).resolves.toEqual({ result: { results: [], appliedStrategies: [] }, invalidateStores: [] });
    expect(conversationSearchService.searchChats).toHaveBeenCalledWith('user-1', {
      query: 'migration error',
      scope: { type: 'current_project' },
      limit: undefined,
      currentConversationId: 'conversation-1',
    });

    await service.executeTool(
      BASE_USER,
      'find_in_chat',
      { conversationId: 'conversation-2', query: 'client_command_id' },
      { conversationId: 'conversation-1' }
    );
    expect(conversationSearchService.findInChat).toHaveBeenCalledWith('user-1', {
      conversationId: 'conversation-2',
      query: 'client_command_id',
      limit: undefined,
      currentConversationId: 'conversation-1',
    });

    await service.executeTool(
      BASE_USER,
      'read_chat_slice',
      { conversationId: 'conversation-2', mode: 'around_message', messageId: 'message-1', limit: 10 },
      { conversationId: 'conversation-1' }
    );
    expect(conversationSearchService.readChatSlice).toHaveBeenCalledWith('user-1', {
      conversationId: 'conversation-2',
      mode: 'around_message',
      messageId: 'message-1',
      cursor: undefined,
      limit: 10,
      currentConversationId: 'conversation-1',
    });

    await service.executeTool(BASE_USER, 'list_chat_projects', { limit: 5 }, { conversationId: 'conversation-1' });
    expect(conversationSearchService.listProjects).toHaveBeenCalledWith('user-1', {
      limit: 5,
      cursor: undefined,
      currentConversationId: 'conversation-1',
    });
  });
});
