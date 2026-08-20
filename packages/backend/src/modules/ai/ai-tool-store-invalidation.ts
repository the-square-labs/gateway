import type { EventBusService } from '@/services/event-bus.service.js';

export const TOOL_STORE_INVALIDATION_CHANNEL_PREFIX = 'tool.store.invalidated.';

const SAFE_CONTEXT_KEYS = [
  'operation',
  'nodeId',
  'containerId',
  'containerName',
  'deploymentId',
  'proxyHostId',
  'projectId',
  'databaseId',
  'certificateId',
  'caId',
  'userId',
  'groupId',
  'registryId',
  'networkId',
  'name',
] as const;

const DOCKER_CONFIG_MUTATION_STORES: Record<string, string[]> = {
  update_env: ['containers', 'tasks'],
  write_file: ['containers'],
  create_secret: ['containers'],
  update_secret: ['containers'],
  delete_secret: ['containers'],
  upsert_webhook: ['containers'],
  delete_webhook: ['containers'],
  regenerate_webhook_token: ['containers'],
  upsert_health_check: ['containers'],
};

export interface ToolStoreInvalidationEvent {
  userId: string;
  source: 'ai' | 'mcp';
  toolName: string;
  stores: string[];
  resourceId?: string;
  context: Record<string, string>;
}

export function resolveToolStoreInvalidations(
  toolName: string,
  args: Record<string, unknown>,
  configuredStores: string[]
): string[] {
  const stores = new Set(configuredStores);
  const operation = typeof args.operation === 'string' ? args.operation : '';

  if (toolName === 'manage_docker_container_config') {
    for (const store of DOCKER_CONFIG_MUTATION_STORES[operation] ?? []) stores.add(store);
  } else if (toolName === 'manage_docker_registry' && ['create', 'update', 'delete'].includes(operation)) {
    stores.add('dockerRegistries');
  } else if (toolName === 'manage_docker_volume') {
    stores.add('volumes');
  } else if (toolName === 'manage_docker_network') {
    stores.add('networks');
    if (operation === 'connect' || operation === 'disconnect') stores.add('containers');
  }

  return [...stores];
}

export function publishToolStoreInvalidation(
  eventBus: EventBusService | undefined,
  event: ToolStoreInvalidationEvent
): void {
  if (!eventBus || event.stores.length === 0) return;
  eventBus.publish(`${TOOL_STORE_INVALIDATION_CHANNEL_PREFIX}${event.userId}`, event);
}

export function toolInvalidationContext(args: Record<string, unknown>): Record<string, string> {
  const context: Record<string, string> = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) context[key] = value;
  }
  return context;
}
