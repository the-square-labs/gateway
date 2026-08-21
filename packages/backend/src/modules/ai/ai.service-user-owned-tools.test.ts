import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { AIService } from './ai.service.js';
import { AIConversationService } from './ai-conversation.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'operators',
  scopes: ['feat:ai:use'] as string[],
  isBlocked: false,
};

function createService() {
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
    {} as never
  );
}

afterEach(() => {
  container.reset();
});

describe('AIService user-owned conversation and OAuth tools', () => {
  it('manages only current-user conversations without rewriting history', async () => {
    const conversation = {
      id: 'conversation-1',
      title: 'Redis check',
      createdAt: new Date('2026-06-25T10:00:00Z'),
      updatedAt: new Date('2026-06-25T10:01:00Z'),
      messageCount: 2,
      messages: [],
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    };
    const conversationService = {
      listConversations: vi.fn().mockResolvedValue([conversation]),
      getConversation: vi.fn().mockResolvedValue(conversation),
      deleteConversation: vi.fn().mockResolvedValue(true),
      deleteConversationByTitle: vi.fn().mockResolvedValue(true),
    };
    container.registerInstance(AIConversationService, conversationService as unknown as AIConversationService);
    const service = createService();

    await expect(service.executeTool(BASE_USER, 'manage_ai_conversation', { operation: 'list' })).resolves.toEqual({
      result: [conversation],
      invalidateStores: [],
    });
    await expect(
      service.executeTool(BASE_USER, 'manage_ai_conversation', {
        operation: 'get',
        conversationId: 'conversation-1',
      })
    ).resolves.toEqual({ result: conversation, invalidateStores: [] });
    await expect(
      service.executeTool(BASE_USER, 'manage_ai_conversation', {
        operation: 'delete',
        conversationId: 'conversation-1',
      })
    ).resolves.toEqual({ result: { deleted: true }, invalidateStores: [] });
    await expect(
      service.executeTool(BASE_USER, 'manage_ai_conversation', {
        operation: 'delete_by_title',
        title: 'Redis check',
      })
    ).resolves.toEqual({ result: { deleted: true }, invalidateStores: [] });

    expect(conversationService.listConversations).toHaveBeenCalledWith(BASE_USER.id);
    expect(conversationService.getConversation).toHaveBeenCalledWith(BASE_USER.id, 'conversation-1');
    expect(conversationService.deleteConversation).toHaveBeenCalledWith(BASE_USER.id, 'conversation-1');
    expect(conversationService.deleteConversationByTitle).toHaveBeenCalledWith(BASE_USER.id, 'Redis check');
    expect('saveConversation' in conversationService).toBe(false);
    expect('updateConversation' in conversationService).toBe(false);
  });

  it('manages existing current-user OAuth authorizations without pending consent flows', async () => {
    const authorization = {
      clientId: 'goc_client',
      clientName: 'Codex',
      resource: 'https://gateway.test/api',
      scopes: ['nodes:details'],
    };
    const oauthService = {
      listUserAuthorizations: vi.fn().mockResolvedValue([authorization]),
      updateUserAuthorizationScopes: vi.fn().mockResolvedValue({ ...authorization, scopes: ['nodes:details'] }),
      revokeUserAuthorization: vi.fn().mockResolvedValue(undefined),
    };
    container.registerInstance(OAuthService, oauthService as unknown as OAuthService);
    const service = createService();

    await expect(service.executeTool(BASE_USER, 'manage_oauth_authorization', { operation: 'list' })).resolves.toEqual({
      result: [authorization],
      invalidateStores: [],
    });
    await expect(
      service.executeTool(BASE_USER, 'manage_oauth_authorization', {
        operation: 'update_scopes',
        clientId: 'goc_client',
        resource: 'https://gateway.test/api',
        scopes: ['nodes:details'],
      })
    ).resolves.toEqual({
      result: { ...authorization, scopes: ['nodes:details'] },
      invalidateStores: ['oauthAuthorizations'],
    });
    await expect(
      service.executeTool(BASE_USER, 'manage_oauth_authorization', {
        operation: 'revoke',
        clientId: 'goc_client',
        resource: 'https://gateway.test/api',
      })
    ).resolves.toEqual({ result: { revoked: true }, invalidateStores: ['oauthAuthorizations'] });

    expect(oauthService.listUserAuthorizations).toHaveBeenCalledWith(BASE_USER.id);
    expect(oauthService.updateUserAuthorizationScopes).toHaveBeenCalledWith(
      BASE_USER,
      'goc_client',
      'https://gateway.test/api',
      ['nodes:details']
    );
    expect(oauthService.revokeUserAuthorization).toHaveBeenCalledWith(
      BASE_USER.id,
      'goc_client',
      'https://gateway.test/api'
    );
    expect('createConsentRequest' in oauthService).toBe(false);
    expect('approveConsent' in oauthService).toBe(false);
  });
});
