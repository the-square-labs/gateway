import { describe, expect, it, vi } from 'vitest';
import {
  publishToolStoreInvalidation,
  resolveToolStoreInvalidations,
  toolInvalidationContext,
} from './ai-tool-store-invalidation.js';

describe('AI and MCP tool store invalidation', () => {
  it('derives operation-specific invalidations for composite Docker tools', () => {
    expect(resolveToolStoreInvalidations('manage_docker_container_config', { operation: 'get_env' }, [])).toEqual([]);
    expect(resolveToolStoreInvalidations('manage_docker_container_config', { operation: 'update_env' }, [])).toEqual([
      'containers',
      'tasks',
    ]);
    expect(resolveToolStoreInvalidations('manage_docker_registry', { operation: 'update' }, [])).toEqual([
      'dockerRegistries',
    ]);
    expect(resolveToolStoreInvalidations('manage_docker_network', { operation: 'connect' }, [])).toEqual([
      'networks',
      'containers',
    ]);
  });

  it('derives operation-specific invalidations for leaf resources managed by composite tools', () => {
    expect(resolveToolStoreInvalidations('manage_api_token', { operation: 'list' }, [])).toEqual([]);
    expect(resolveToolStoreInvalidations('manage_api_token', { operation: 'update' }, [])).toEqual(['apiTokens']);
    expect(resolveToolStoreInvalidations('manage_inference_token', { operation: 'revoke' }, [])).toEqual([
      'inferenceTokens',
    ]);
    expect(resolveToolStoreInvalidations('manage_oauth_authorization', { operation: 'update_scopes' }, [])).toEqual([
      'oauthAuthorizations',
    ]);
    expect(resolveToolStoreInvalidations('manage_logging', { resource: 'token', operation: 'create' }, [])).toEqual([
      'loggingTokens',
    ]);
    expect(resolveToolStoreInvalidations('manage_pages', { operation: 'token_revoke' }, [])).toEqual(['pageTokens']);
    expect(resolveToolStoreInvalidations('upload_pages_artifact', { operation: 'begin' }, [])).toEqual(['pages']);
    expect(resolveToolStoreInvalidations('upload_pages_artifact', { operation: 'chunk' }, [])).toEqual([]);
    expect(resolveToolStoreInvalidations('upload_pages_artifact', { operation: 'finalize' }, [])).toEqual([
      'pages',
      'proxy-hosts',
    ]);
  });

  it('publishes only safe resource context to the target user channel', () => {
    const eventBus = { publish: vi.fn() };
    const context = toolInvalidationContext({
      operation: 'update_env',
      nodeId: 'node-1',
      containerId: 'container-1',
      env: { SECRET: 'must-not-leak' },
      password: 'must-not-leak',
    });

    publishToolStoreInvalidation(eventBus as never, {
      userId: 'user-1',
      source: 'mcp',
      toolName: 'manage_docker_container_config',
      stores: ['containers', 'tasks'],
      resourceId: 'container-1',
      context,
    });

    expect(eventBus.publish).toHaveBeenCalledWith('tool.store.invalidated.user-1', {
      userId: 'user-1',
      source: 'mcp',
      toolName: 'manage_docker_container_config',
      stores: ['containers', 'tasks'],
      resourceId: 'container-1',
      context: { operation: 'update_env', nodeId: 'node-1', containerId: 'container-1' },
    });
  });
});
