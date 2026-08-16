import type { AIToolDefinition } from './ai.types.js';

export const FOLDER_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'list_resource_folders',
    description:
      'List folders for a Gateway resource type. Use this before moving resources between folders or when the user asks about folder layout.',
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: [
            'nodes',
            'databases',
            'domains',
            'logging_environments',
            'logging_schemas',
            'admin_users',
            'permission_groups',
            'proxy_hosts',
            'docker',
          ],
          description: 'Foldered resource type to inspect.',
        },
        dockerResourceType: {
          type: 'string',
          enum: ['container', 'image', 'network', 'volume'],
          description: 'Docker resource subtype when resourceType is docker. Default: container.',
        },
      },
      required: ['resourceType'],
    },
    destructive: false,
    category: 'Folders',
    requiredScope: 'nodes:folders:manage',
    invalidateStores: [],
  },
  {
    name: 'manage_resource_folder',
    description:
      'Create, update, move, delete, reorder, or assign foldered Gateway resources. Use the resource-specific ids and resourceType.',
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: [
            'nodes',
            'databases',
            'domains',
            'logging_environments',
            'logging_schemas',
            'admin_users',
            'permission_groups',
            'proxy_hosts',
            'docker',
          ],
        },
        operation: {
          type: 'string',
          enum: ['create', 'update', 'move_folder', 'delete', 'reorder_folders', 'move_resources', 'reorder_resources'],
          description: 'Folder operation to perform.',
        },
        folderId: { type: 'string', description: 'Folder UUID for update/move/delete or target folder for resources.' },
        name: { type: 'string', description: 'Folder name for create/update.' },
        parentId: {
          type: 'string',
          description: 'Parent folder UUID for create/move_folder. Use null for top-level on move_folder.',
        },
        resourceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Resource UUIDs to move for non-Docker resources, or route UUIDs for proxy_hosts.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Folder/resource UUID for reorder operations.' },
              sortOrder: { type: 'number', description: 'Zero-based sort order.' },
              nodeId: { type: 'string', description: 'Docker node UUID for Docker resources.' },
              resourceKey: { type: 'string', description: 'Docker resource key/name for Docker resources.' },
            },
          },
          description: 'Reorder entries or Docker resource refs. Docker move_resources uses [{ nodeId, resourceKey }].',
        },
        dockerResourceType: {
          type: 'string',
          enum: ['container', 'image', 'network', 'volume'],
          description: 'Docker resource subtype when resourceType is docker. Default: container.',
        },
      },
      required: ['resourceType', 'operation'],
    },
    destructive: true,
    category: 'Folders',
    requiredScope: 'nodes:folders:manage',
    invalidateStores: ['folders'],
  },
];
