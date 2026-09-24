import type { AIToolDefinition } from './ai.types.js';

export const OPERATION_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_logging',
    description:
      'Manage external logging environments, schemas, ingest tokens, metadata, facets, and search. Use canonical args like { resource: "schema", operation: "create", payload: { name, schemaMode, fieldSchema } } or { resource: "environment", operation: "list", search }. Resource slugs are assigned by the backend. Operation-specific logs:* scopes are enforced. { resource: "health", operation: "get" } returns the logging storage maintenance snapshot (housekeeping:view).',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: ['environment', 'schema', 'token', 'logs', 'metadata', 'facets', 'health'] },
        operation: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'search', 'facets', 'metadata'],
        },
        environmentId: { type: 'string' },
        schemaId: { type: 'string' },
        tokenId: { type: 'string' },
        search: { type: 'string' },
        payload: {
          type: 'object',
          description:
            'Create/update/search/facets body matching the logging API schema. Schema payload fields: name, description?, schemaMode ("loose"|"strip"|"reject"), fieldSchema[]. Environment payload fields: name, description?, enabled?, schemaId?, schemaMode, retentionDays, fieldSchema[]. Resource slugs are assigned by the backend. Search payload fields: from?, to?, query?, limit?, cursor?, services?, sources?, expression?.',
        },
      },
      required: ['resource', 'operation'],
    },
    destructive: true,
    category: 'Logging',
    requiredScope: 'logs:environments:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_status_page',
    description:
      'Manage the status page settings, service list and order, incidents, incident updates, proxy template options, and preview. services.reorder takes payload { serviceIds } in the new display order. Operation-specific status-page:* scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: ['settings', 'proxy_templates', 'services', 'incidents', 'incident_updates', 'preview'],
        },
        operation: {
          type: 'string',
          enum: [
            'get',
            'list',
            'update',
            'create',
            'delete',
            'reorder',
            'resolve',
            'promote',
            'create_update',
            'preview',
          ],
        },
        serviceId: { type: 'string' },
        incidentId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'resolved', 'all'] },
        limit: { type: 'number' },
        payload: { type: 'object', description: 'Create/update body matching the status page API schema' },
      },
      required: ['resource', 'operation'],
    },
    destructive: true,
    category: 'Status Page',
    requiredScope: 'status-page:view',
    invalidateStores: [],
  },
];
