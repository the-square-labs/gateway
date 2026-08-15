import type { AIToolDefinition } from './ai.types.js';

export const RESOURCE_SETUP_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_managed_database',
    description:
      'Provision and manage Gateway-managed Postgres, Redis, or ClickHouse instances and their workload bindings. Read the catalog before create, poll get until ready, and create a binding only after the database is ready. This tool never reveals credentials.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'catalog',
            'list',
            'get',
            'create',
            'retry',
            'delete',
            'list_bindings',
            'create_binding',
            'delete_binding',
          ],
        },
        databaseId: { type: 'string', description: 'Managed database instance ID.' },
        bindingId: { type: 'string', description: 'Managed database binding ID.' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['postgres', 'redis', 'clickhouse'] },
        version: { type: 'string', description: 'Exact version returned by catalog.' },
        nodeId: { type: 'string', description: 'Database node ID for create, or optional list filter.' },
        storageSizeGb: { type: 'number' },
        cpuCores: { type: 'number' },
        memoryMb: { type: 'number' },
        swapMb: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        publishTcp: {
          type: 'boolean',
          description: 'Keep false unless the user explicitly needs external TCP access.',
        },
        publishNativeTcp: { type: 'boolean' },
        publishedPort: { type: 'number' },
        publishedNativePort: { type: 'number' },
        tlsEnabled: { type: 'boolean' },
        databaseName: { type: 'string' },
        ownerUsername: { type: 'string' },
        targetNodeId: { type: 'string' },
        targetType: { type: 'string', enum: ['container', 'deployment'] },
        targetResourceId: { type: 'string' },
        environment: {
          type: 'object',
          description:
            'Optional environment variable names for connectionUri, host, port, database, username, and password.',
        },
        replaceExistingEnvironment: { type: 'boolean' },
        targetEnvironment: {
          type: 'object',
          description: 'Complete ordinary-container environment draft when the binding changes it.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Managed Databases',
    requiredScope: 'databases:view',
    invalidateStores: ['databases', 'containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_migration',
    description:
      'Preflight, start, inspect, cancel, or retry cleanup for a Gateway Docker container/deployment migration. Always preflight first and pass its exact fingerprint to start. A migration requires an existing source workload and a distinct target Docker node.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['preflight', 'start', 'get', 'cancel', 'retry_cleanup'] },
        migrationId: { type: 'string' },
        resource: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['container', 'deployment'] },
            containerName: { type: 'string' },
            deploymentId: { type: 'string' },
          },
          required: ['type'],
        },
        sourceNodeId: { type: 'string' },
        targetNodeId: { type: 'string' },
        keepSource: { type: 'boolean' },
        preflightFingerprint: { type: 'string' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Docker Migration',
    requiredScope: 'docker:containers:migrate',
    invalidateStores: ['containers', 'docker-deployments', 'docker-tasks'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_logging_backend',
    description:
      'Inspect or configure the structured-logging ClickHouse backend. On an empty Gateway, enable_local provisions the Gateway-managed local ClickHouse backend before creating logging environments or schemas. Use configure_external only with user-supplied connection details.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'enable_local', 'configure_external', 'disable'] },
        url: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        database: { type: 'string' },
        table: { type: 'string' },
        requestTimeoutMs: { type: 'number' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Logging Backend',
    requiredScope: 'settings:gateway:view',
    invalidateStores: ['settings', 'logging'],
    historyRetention: { mode: 'summary_only' },
  },
];
