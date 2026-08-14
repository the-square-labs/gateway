import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AIService } from './ai.service.js';
import { AIConversationService } from './ai-conversation.service.js';

const BASE_USER = {
  id: 'user-1',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['feat:ai:use'] as string[],
  isBlocked: false,
};

function createService(config: Record<string, unknown> = {}) {
  return new AIService(
    { getConfig: vi.fn().mockResolvedValue({ disabledTools: [], webSearchEnabled: false, ...config }) } as never,
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

describe('AIService discovery tools', () => {
  afterEach(() => {
    container.reset();
  });

  it('returns the current page context supplied for this tool execution', async () => {
    const service = createService();

    const result = await service.executeTool(
      BASE_USER,
      'get_current_context',
      {},
      {
        pageContext: {
          route: '/proxy-hosts/host-1/settings',
          resourceType: 'proxy_host',
          resourceId: 'host-1',
        },
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      hasCurrentPage: true,
      currentPage: {
        route: '/proxy-hosts/host-1/settings',
        resourceType: 'proxy_host',
        resourceId: 'host-1',
      },
    });
  });

  it('recommends bounded categories, then activates only explicit categories', async () => {
    const service = createService({ disabledTools: ['get_current_context'], webSearchEnabled: true });

    const recommendation = await service.executeTool(
      { ...BASE_USER, scopes: ['feat:ai:use', 'logs:schemas:create', 'logs:schemas:view'] },
      'discover_tools',
      { query: 'schema' }
    );

    expect(recommendation.error).toBeUndefined();
    expect(recommendation.result).toMatchObject({
      totalCallableTools: expect.any(Number),
      tools: undefined,
      recommendedToolsets: expect.arrayContaining([expect.objectContaining({ name: 'Logging' })]),
    });
    expect(recommendation.result).not.toHaveProperty('discoveredToolsets');
    expect(
      (recommendation.result as { recommendedToolsets: Array<{ name: string }> }).recommendedToolsets.length
    ).toBeLessThanOrEqual(3);

    const activation = await service.executeTool(
      { ...BASE_USER, scopes: ['feat:ai:use', 'logs:schemas:create', 'logs:schemas:view'] },
      'discover_tools',
      { categories: ['Logging'], includeTools: true }
    );
    expect(activation.result).toMatchObject({
      categories: [expect.objectContaining({ name: 'Logging' })],
      discoveredToolsets: ['Logging'],
      tools: [
        expect.objectContaining({
          name: 'manage_logging',
          category: 'Logging',
          destructive: true,
        }),
      ],
    });
    expect(
      (activation.result as { categories: Array<{ name: string }>; tools: Array<{ name: string }> }).categories.map(
        (category) => category.name
      )
    ).toEqual(['Logging']);
    expect(
      (activation.result as { tools: Array<{ name: string }> }).tools.some(
        (tool) => tool.name === 'get_current_context'
      )
    ).toBe(false);
  });

  it('persists discovered toolsets and page context when a conversation is attached', async () => {
    const updateRuntimeState = vi.fn().mockResolvedValue(null);
    container.registerInstance(AIConversationService, {
      updateRuntimeState,
    } as unknown as AIConversationService);
    const service = createService();

    await service.executeTool(
      { ...BASE_USER, scopes: ['feat:ai:use', 'logs:schemas:view'] },
      'discover_tools',
      { categories: ['Logging'], includeTools: true },
      {
        conversationId: 'conversation-1',
        pageContext: { route: '/logging', resourceType: 'logging', resourceId: 'env-1' },
      }
    );

    expect(updateRuntimeState).toHaveBeenCalledWith('user-1', 'conversation-1', {
      lastContext: { route: '/logging', resourceType: 'logging', resourceId: 'env-1' },
      discoveredToolsets: ['Logging'],
    });
  });

  it('does not clear the active tool working set when discovery only recommends categories', async () => {
    const updateRuntimeState = vi.fn().mockResolvedValue(null);
    container.registerInstance(AIConversationService, {
      updateRuntimeState,
    } as unknown as AIConversationService);
    const service = createService();

    const recommendation = await service.executeTool(
      { ...BASE_USER, scopes: ['feat:ai:use', 'logs:schemas:view'] },
      'discover_tools',
      { query: 'schema' },
      { conversationId: 'conversation-1' }
    );

    expect(recommendation.error).toBeUndefined();
    expect(recommendation.result).not.toHaveProperty('discoveredToolsets');
    expect(updateRuntimeState).not.toHaveBeenCalled();
  });
});
