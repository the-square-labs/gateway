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
