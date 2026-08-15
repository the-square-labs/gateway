import type { AIToolDefinition } from './ai.types.js';

export const SSH_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'ssh_list_connectors',
    description: 'List available external SSH connectors. Gateway-managed nodes are intentionally excluded.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'ssh_execute_command',
    description:
      'Execute one command on an external SSH connector. Use only after identifying the host and command; Gateway will apply its standard approval policy.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: 'External SSH connector UUID.' },
        command: { type: 'string', description: 'POSIX shell command to execute.' },
      },
      required: ['connectorId', 'command'],
    },
    destructive: true,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
    effect: 'external',
    approvalClass: 'execute',
  },
  {
    name: 'create_ssh_connector',
    description:
      'Create a password-authenticated external SSH connector only when every required field and the confirmed host fingerprint are already known. For generated-key setup or host-key discovery, use open_connector_setup with connector ssh.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        username: { type: 'string' },
        secret: { type: 'string', description: 'SSH account password.' },
        hostFingerprint: {
          type: 'string',
          description: 'Pinned SHA256 host key fingerprint explicitly confirmed by the user.',
        },
        jumpConnectorId: { type: 'string' },
      },
      required: ['name', 'host', 'username', 'secret', 'hostFingerprint'],
    },
    destructive: true,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:manage',
    invalidateStores: ['integrations'],
    historyRetention: { mode: 'never_full' },
    effect: 'write',
    approvalClass: 'create',
  },
];
