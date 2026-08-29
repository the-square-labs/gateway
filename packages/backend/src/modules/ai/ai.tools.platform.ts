import { NODE_FILE_AI_TOOLS } from './ai.tools.node-files.js';
import type { AIToolDefinition } from './ai.types.js';

export const PLATFORM_AI_TOOLS: AIToolDefinition[] = [
  // ── Nodes ──
  {
    name: 'list_nodes',
    description: 'List all daemon nodes with their type, status, and connection info.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by hostname' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'builder', 'databases', 'relay', 'bastion'],
          description: 'Filter by node type',
        },
        status: { type: 'string', enum: ['pending', 'online', 'offline'], description: 'Filter by status' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'get_node',
    description: 'Get detailed information about a specific node including live health, stats, and system info.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'execute_node_console_command',
    description:
      'Run a one-shot command on a daemon node console. This is destructive by policy even for read-looking commands. Use command as argv, for example ["sh","-lc","systemctl status nginx --no-pager"]. Clearly dangerous commands are blocked; commands with risky patterns require explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command argv to execute. Use ["sh","-lc","..."] for shell syntax.',
        },
      },
      required: ['nodeId', 'command'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:console',
    invalidateStores: ['nodes'],
  },
  {
    name: 'create_node',
    description:
      'Create a new daemon node and generate an enrollment token. IMPORTANT: The response contains enrollmentToken and gatewayCertSha256 — you MUST display both to the user and include --gateway-cert-sha256 in setup commands (curl/wget). The token is one-time-use and cannot be retrieved again.',
    parameters: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'Node hostname (e.g., "proxy-01.example.com")' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'builder', 'databases', 'relay', 'bastion'],
          description: 'Node type (default: nginx)',
        },
        displayName: { type: 'string', description: 'Optional display name' },
      },
      required: ['hostname'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:create',
    invalidateStores: ['nodes'],
  },
  {
    name: 'rename_node',
    description: 'Update a node display name.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        displayName: { type: 'string', description: 'New display name' },
      },
      required: ['nodeId', 'displayName'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:rename',
    invalidateStores: ['nodes'],
  },
  {
    name: 'delete_node',
    description:
      'Delete a daemon node. The node must have no assigned ingress routes. Also revokes its mTLS certificate.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID to delete' },
      },
      required: ['nodeId'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:delete',
    invalidateStores: ['nodes'],
  },
  {
    name: 'manage_node_config',
    description:
      'Read, update, or test the global nginx configuration on a node. Operations: read, update, test. read requires nodes:config:view:<nodeId>; update/test require nodes:config:edit:<nodeId>.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['read', 'update', 'test'],
          description: 'Node config operation to perform.',
        },
        nodeId: { type: 'string', description: 'Node UUID' },
        content: { type: 'string', description: 'Full nginx config content for update.' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:config:view',
    invalidateStores: ['nodes'],
  },
  ...NODE_FILE_AI_TOOLS,

  // ── Raw Config ──
  {
    name: 'get_route_rendered_config',
    description:
      'Get the rendered nginx configuration for an ingress route. Shows either the template-generated or raw config.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
      },
      required: ['routeId'],
    },
    destructive: false,
    category: 'Ingress',
    requiredScope: 'proxy:raw:read',
    invalidateStores: [],
  },
  {
    name: 'update_route_raw_config',
    description: 'Write raw nginx configuration for an ingress route. Raw mode must be enabled first.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        rawConfig: { type: 'string', description: 'Raw nginx configuration content' },
      },
      required: ['routeId', 'rawConfig'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:raw:write',
    invalidateStores: ['proxy'],
  },
  {
    name: 'toggle_route_raw_mode',
    description:
      'Enable or disable raw config mode on an ingress route. When enabled, template rendering is bypassed and the raw config is used directly.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        enabled: { type: 'boolean', description: 'true to enable raw mode, false to disable' },
      },
      required: ['routeId', 'enabled'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:raw:toggle',
    invalidateStores: ['proxy'],
  },

  // ── Administration ──
  {
    name: 'list_users',
    description: 'List all users with their roles, email, and last login info.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: [],
  },
  {
    name: 'create_user',
    description:
      'Create a user before first login and assign an initial permission group. You can only assign groups within your own effective scopes.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'User email address' },
        name: { type: 'string', description: 'Optional display name' },
        groupId: { type: 'string', description: 'Initial permission group UUID' },
      },
      required: ['email', 'groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'update_user_role',
    description: "Change a user's permission group. Use list_users to see available groups.",
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        groupId: { type: 'string', description: 'Permission group UUID to assign' },
      },
      required: ['userId', 'groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'set_user_additional_permissions',
    description:
      "Replace a user's exact additional permissions. Use list_users first to inspect groupScopes, additionalScopes, and effective scopes. Pass an empty additionalScopes array to reset all user-specific permissions while keeping the user's permission group unchanged.",
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        additionalScopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Complete replacement list of user-specific permission scopes; [] resets the override',
        },
      },
      required: ['userId', 'additionalScopes'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'set_user_blocked',
    description:
      'Block or unblock a user account. Cannot target yourself, the system user, or users whose scopes exceed yours.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        blocked: { type: 'boolean', description: 'true to block, false to unblock' },
      },
      required: ['userId', 'blocked'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'delete_user',
    description:
      'Soft-delete a user account and revoke access. Cannot target yourself, the system user, or users whose scopes exceed yours. Restoration is available only to system administrators through the Administration UI/API.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
      },
      required: ['userId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },

  // ── AI Assistant Configuration ──
  {
    name: 'get_ai_settings',
    description:
      'Read AI Workspace configuration, including provider, limits, disabled tools, web search, and sandbox runner settings. Secrets are returned only as masked metadata.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'update_ai_settings',
    description:
      'Update AI Workspace configuration. Only pass fields that should change; API keys may be replaced or cleared with an empty string.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable or disable AI Workspace.' },
        providerType: {
          type: 'string',
          enum: ['openai_compatible', 'gateway_inference'],
          description: 'Assistant response provider.',
        },
        providerUrl: { type: 'string', description: 'OpenAI-compatible provider base URL.' },
        endpointMode: {
          type: 'string',
          enum: ['auto', 'chat_completions', 'responses'],
          description: 'Provider endpoint family.',
        },
        apiKey: { type: 'string', description: 'Provider API key. Empty string clears the saved key.' },
        model: { type: 'string', description: 'Model name.' },
        gatewayInferenceModel: {
          type: 'string',
          description: 'Default published Gateway Inference model ID.',
        },
        gatewayInferenceAllowUserModelSelection: {
          type: 'boolean',
          description: 'Allow users to select another accessible Gateway Inference model.',
        },
        allowUserReasoningEffortSelection: {
          type: 'boolean',
          description: 'Allow users to override the default reasoning effort for the OpenAI-compatible provider.',
        },
        customSystemPrompt: { type: 'string', description: 'Additional system prompt instructions.' },
        rateLimitMax: { type: 'number', description: 'Maximum assistant requests per window.' },
        rateLimitWindowSeconds: { type: 'number', description: 'Rate limit window in seconds.' },
        maxToolRounds: { type: 'number', description: 'Maximum sequential tool calls per assistant response.' },
        maxContextTokens: { type: 'number', description: 'Context token budget.' },
        maxCompletionTokens: { type: 'number', description: 'Maximum generated response tokens.' },
        maxTokensField: {
          type: 'string',
          enum: ['max_tokens', 'max_completion_tokens'],
          description: 'Provider request token field.',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'none'],
          description: 'Reasoning effort setting.',
        },
        disabledTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names disabled for the assistant.',
        },
        webSearchProvider: {
          type: 'string',
          enum: ['tavily', 'brave', 'serper', 'searxng', 'exa'],
          description: 'Web search provider.',
        },
        webSearchBaseUrl: { type: 'string', description: 'Web search provider base URL, used by SearXNG.' },
        webSearchApiKey: { type: 'string', description: 'Web search API key. Empty string clears the saved key.' },
        sandboxEnabled: { type: 'boolean', description: 'Expose sandbox execution tools to the assistant.' },
        sandboxDefaultTier: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Default sandbox resource tier.',
        },
      },
    },
    destructive: true,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: ['settings'],
  },
  {
    name: 'list_ai_tools',
    description:
      'List AI Workspace tools with categories, descriptions, scopes, and destructive metadata for configuration or auditing.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'get_sandbox_runtime_status',
    description:
      'Read sandbox runner configuration and runtime health without starting a sandbox job. Use this to diagnose whether sandbox execution is enabled and available.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'manage_ai_conversation',
    description:
      'Manage the current user AI conversations. Operations: list, get, delete, delete_by_title. This tool never creates or rewrites conversation history.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'delete', 'delete_by_title'],
          description: 'Conversation operation to perform.',
        },
        conversationId: { type: 'string', description: 'Conversation UUID for get or delete.' },
        title: { type: 'string', description: 'Conversation title for delete_by_title.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Conversations',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'manage_oauth_authorization',
    description:
      'Manage existing OAuth authorizations for the current user. Operations: list, update_scopes, revoke. Pending browser consent is intentionally not exposed.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'update_scopes', 'revoke'],
          description: 'OAuth authorization operation to perform.',
        },
        clientId: { type: 'string', description: 'OAuth client ID for update_scopes or revoke.' },
        resource: { type: 'string', description: 'OAuth resource URL for update_scopes or revoke.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement delegated scopes for update_scopes.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'OAuth',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'manage_api_token',
    description:
      'Manage Gateway API tokens for the current browser user. Operations: list, create, update, revoke. Token secrets are returned only on create.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'create', 'update', 'revoke'],
          description: 'API token operation to perform.',
        },
        tokenId: { type: 'string', description: 'Token UUID for update or revoke.' },
        name: { type: 'string', description: 'Token name for create or update.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'API token scopes for create or update. Must be a subset of the current user scopes.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Settings',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
  },
];
