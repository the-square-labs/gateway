import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { container } from '@/container.js';
import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { FOLDER_TOOL_REQUIREMENT_SCOPES } from '@/modules/ai/ai.folder-tool-scopes.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AI_TOOLS } from '@/modules/ai/ai.tools.js';
import type { AIToolDefinition } from '@/modules/ai/ai.types.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { setAuditMcpContext } from '@/modules/audit/audit-request-context.js';
import type { User } from '@/types.js';
import type { McpAuthContext } from './mcp-types.js';

const MCP_EXCLUDED_TOOLS = new Set([
  'ask_question',
  'get_current_context',
  'end_conversation',
  'search_chats',
  'find_in_chat',
  'read_chat_slice',
  'list_projects',
  'list_chat_projects',
  'internal_documentation',
  'web_search',
  'wait',
  'send_comment',
  'manage_ai_conversation',
  'manage_oauth_authorization',
  'manage_api_token',
  'manage_inference_provider',
  'manage_inference_model',
  'manage_inference_limits',
  'manage_inference_token',
  'execute_script',
  'run_process',
  'fetch',
  'download_artifact',
  'list_artifact_files',
  'read_artifact',
  'send_artifact',
  'read_process_output',
  'write_process_stdin',
  'kill_process',
  'list_sandbox_jobs',
  'manage_node_config',
  'manage_node_file',
  'set_resource_pin',
]);
const BROAD_ONLY_TOOL_SCOPES = new Set<string>();
const DIRECT_DATABASE_VIEW_TOOLS = new Set(['list_databases', 'get_database_connection']);
const DIRECT_RAW_READ_TOOLS = new Set(['get_proxy_rendered_config']);
const DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS = new Set([
  'query_postgres_read',
  'execute_postgres_sql',
  'browse_redis_keys',
  'get_redis_key',
  'set_redis_key',
  'execute_redis_command',
  'manage_postgres_data',
  'manage_redis_data',
]);
const ANY_SCOPE_TOOL_REQUIREMENTS: Record<string, string[]> = {
  find_resource: [
    'nodes:details',
    'proxy:view',
    'proxy:templates:view',
    'ssl:cert:view',
    'domains:view',
    'acl:view',
    'pki:ca:view:root',
    'pki:ca:view:intermediate',
    'pki:cert:view',
    'pki:templates:view',
    'docker:containers:view',
    'docker:images:view',
    'docker:volumes:view',
    'docker:networks:view',
    'docker:registries:view',
    'databases:view',
    'logs:environments:view',
    'logs:schemas:view',
    'status-page:view',
    'notifications:view',
  ],
  list_cas: ['pki:ca:view:root', 'pki:ca:view:intermediate'],
  get_ca: ['pki:ca:view:root', 'pki:ca:view:intermediate'],
  delete_ca: ['pki:ca:revoke:root', 'pki:ca:revoke:intermediate'],
  manage_ca: ['pki:ca:create:root', 'pki:ca:create:intermediate'],
  manage_certificate: ['pki:cert:view', 'pki:cert:issue', 'pki:cert:export'],
  manage_template: ['pki:templates:view', 'pki:templates:edit'],
  manage_proxy_template: [
    'proxy:templates:view',
    'proxy:templates:create',
    'proxy:templates:edit',
    'proxy:templates:delete',
  ],
  manage_ssl_certificate: ['ssl:cert:view', 'ssl:cert:issue', 'ssl:cert:delete'],
  manage_domain: ['domains:view', 'domains:edit'],
  manage_access_list: ['acl:view', 'acl:edit'],
  manage_docker_registry: [
    'docker:registries:view',
    'docker:registries:create',
    'docker:registries:edit',
    'docker:registries:delete',
  ],
  manage_docker_volume: ['docker:volumes:create', 'docker:volumes:delete'],
  manage_docker_network: ['docker:networks:create', 'docker:networks:edit', 'docker:networks:delete'],
  manage_docker_container_config: [
    'docker:containers:view',
    'docker:containers:environment',
    'docker:containers:files',
    'docker:containers:secrets',
    'docker:containers:webhooks',
    'docker:containers:config',
    'docker:containers:edit',
  ],
  manage_database_connection: [
    'databases:view',
    'databases:create',
    'databases:edit',
    'databases:delete',
    'databases:credentials:reveal',
  ],
  manage_logging: [
    'logs:environments:view',
    'logs:environments:create',
    'logs:environments:edit',
    'logs:environments:delete',
    'logs:tokens:view',
    'logs:tokens:create',
    'logs:tokens:delete',
    'logs:schemas:view',
    'logs:schemas:create',
    'logs:schemas:edit',
    'logs:schemas:delete',
    'logs:read',
    'logs:manage',
  ],
  manage_status_page: [
    'status-page:view',
    'status-page:manage',
    'status-page:incidents:create',
    'status-page:incidents:update',
    'status-page:incidents:resolve',
    'status-page:incidents:delete',
  ],
  list_resource_folders: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_resource_folder: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_node_config: ['nodes:config:view', 'nodes:config:edit'],
};
const SENSITIVE_TOOL_ARG_RE =
  /(?:password|passwd|secret|signingsecret|privatekey|private_key|token|authorization|cookie|apikey|api_key|clientsecret|client_secret|refresh)/i;
const MCP_ALWAYS_VISIBLE_AI_TOOLS = new Set(['find_resource']);
const MCP_TOOLS_PAGE_SIZE = 80;
const MCP_DISCOVERY_STATE_TTL_MS = 24 * 60 * 60 * 1000;

interface McpToolsetDefinition {
  id: string;
  title: string;
  description: string;
  toolNames: string[];
  isDefault?: boolean;
}

interface McpDiscoveryState {
  activeToolsets: Set<string>;
  lastAccessAt: number;
}

const mcpDiscoveryStates = new Map<string, McpDiscoveryState>();

function toolNamesForCategories(categories: string[]): string[] {
  const categorySet = new Set(categories);
  return AI_TOOLS.filter((tool) => categorySet.has(tool.category)).map((tool) => tool.name);
}

const MCP_TOOLSET_DEFINITIONS: McpToolsetDefinition[] = [
  {
    id: 'core',
    title: 'Core inventory',
    description: 'Small default inventory surface for nodes, common read-only resources, and resource search.',
    isDefault: true,
    toolNames: [
      'list_nodes',
      'get_node',
      'list_proxy_hosts',
      'get_proxy_host',
      'list_ssl_certificates',
      'list_domains',
      'list_access_lists',
      'list_databases',
      'get_database_connection',
      'list_cas',
      'list_certificates',
      'list_templates',
      'list_resource_folders',
    ],
  },
  {
    id: 'folders',
    title: 'Folders',
    description: 'Folder layout and foldered resource assignment operations across Gateway resources.',
    toolNames: toolNamesForCategories(['Folders']),
  },
  {
    id: 'nodes',
    title: 'Nodes',
    description: 'Node inventory and lifecycle operations.',
    toolNames: toolNamesForCategories(['Nodes']),
  },
  {
    id: 'proxy',
    title: 'Reverse proxy',
    description: 'Proxy hosts, folders, templates, domains, access lists, and raw proxy operations when delegated.',
    toolNames: toolNamesForCategories(['Reverse Proxy', 'Domains', 'Access Lists']),
  },
  {
    id: 'certificates',
    title: 'PKI and certificates',
    description: 'Certificate authorities, PKI certificates, PKI templates, and SSL certificates.',
    toolNames: toolNamesForCategories([
      'PKI - Certificate Authorities',
      'PKI - Certificates',
      'PKI - Templates',
      'SSL Certificates',
    ]),
  },
  {
    id: 'docker',
    title: 'Docker',
    description: 'Docker containers, deployments, images, volumes, networks, registries, tasks, and config operations.',
    toolNames: toolNamesForCategories(['Docker']),
  },
  {
    id: 'databases',
    title: 'Databases',
    description: 'Database connections, PostgreSQL data tools, and Redis data tools.',
    toolNames: toolNamesForCategories(['Databases']),
  },
  {
    id: 'logging',
    title: 'Logging',
    description: 'Logging environments, tokens, schemas, metadata, search, and facets.',
    toolNames: toolNamesForCategories(['Logging']),
  },
  {
    id: 'status_page',
    title: 'Status page',
    description: 'Status page services, incidents, settings, templates, and preview.',
    toolNames: toolNamesForCategories(['Status Page']),
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Alert rules, webhooks, delivery logs, and notification statistics.',
    toolNames: toolNamesForCategories(['Notifications']),
  },
  {
    id: 'administration',
    title: 'Administration',
    description: 'Administrative tools that are still subject to MCP/OAuth delegability and token scopes.',
    toolNames: toolNamesForCategories(['Administration']),
  },
  {
    id: 'maintenance',
    title: 'Maintenance',
    description: 'License and housekeeping control-plane operations when delegated.',
    toolNames: toolNamesForCategories(['Maintenance']),
  },
  {
    id: 'ai_assistant',
    title: 'AI assistant',
    description: 'AI assistant provider, limits, tool access, web search, and sandbox runner configuration.',
    toolNames: toolNamesForCategories(['AI Assistant']),
  },
];

const MCP_TOOLSET_BY_ID = new Map(MCP_TOOLSET_DEFINITIONS.map((toolset) => [toolset.id, toolset]));
const MCP_DEFAULT_TOOLSET_IDS = new Set(
  MCP_TOOLSET_DEFINITIONS.filter((toolset) => toolset.isDefault).map((toolset) => toolset.id)
);
const MCP_DISCOVER_TOOLS_DEFINITION = {
  name: 'discover_tools',
  description:
    'List Gateway MCP toolsets or activate a toolset by category id. Use this before specialized work, then call tools/list again to refresh the visible Gateway tools without loading every tool at once.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: MCP_TOOLSET_DEFINITIONS.map((toolset) => toolset.id),
        description: 'Optional toolset id to activate for this OAuth token/client.',
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
  },
  _meta: {
    category: 'MCP Discovery',
  },
};

function isEligibleMcpTool(tool: AIToolDefinition): boolean {
  return tool.category !== 'GitLab' && !!tool.requiredScope && !MCP_EXCLUDED_TOOLS.has(tool.name);
}

function hasDirectScopeBase(scopes: string[], baseScope: string): boolean {
  return scopes.includes(baseScope) || scopes.some((scope) => scope.startsWith(`${baseScope}:`));
}

function getDirectResourceScopedIds(scopes: string[], baseScope: string): string[] {
  return scopes
    .filter((scope) => scope.startsWith(`${baseScope}:`) && scope.length > baseScope.length + 1)
    .map((scope) => scope.slice(baseScope.length + 1));
}

function hasDirectDatabaseViewForQueryTool(scopes: string[], queryScope: string): boolean {
  if (!hasScopeBase(scopes, queryScope) || !hasDirectScopeBase(scopes, 'databases:view')) return false;
  if (scopes.includes('databases:view') || hasScope(scopes, queryScope)) return true;

  const queryIds = new Set(getResourceScopedIds(scopes, queryScope));
  return getDirectResourceScopedIds(scopes, 'databases:view').some((databaseId) => queryIds.has(databaseId));
}

function hasDirectDatabaseViewForResource(scopes: string[], databaseId: string): boolean {
  return scopes.includes('databases:view') || scopes.includes(`databases:view:${databaseId}`);
}

function hasToolScope(scopes: string[], tool: AIToolDefinition): boolean {
  if (!tool.requiredScope) return false;
  if (DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS.has(tool.name)) {
    return hasDirectDatabaseViewForQueryTool(scopes, tool.requiredScope);
  }
  const anyRequirements = ANY_SCOPE_TOOL_REQUIREMENTS[tool.name];
  if (anyRequirements) return anyRequirements.some((scope) => hasScopeBase(scopes, scope));
  if (DIRECT_DATABASE_VIEW_TOOLS.has(tool.name)) {
    return hasDirectScopeBase(scopes, tool.requiredScope);
  }
  if (DIRECT_RAW_READ_TOOLS.has(tool.name)) {
    return hasDirectScopeBase(scopes, tool.requiredScope);
  }
  return BROAD_ONLY_TOOL_SCOPES.has(tool.name)
    ? hasScope(scopes, tool.requiredScope)
    : hasScopeBase(scopes, tool.requiredScope);
}

function hasToolScopeForArgs(scopes: string[], tool: AIToolDefinition, args: Record<string, unknown>): boolean {
  if (!tool.requiredScope) return false;
  if (DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS.has(tool.name)) {
    const resourceId = getToolAuthorizationResourceId(tool.name, args);
    return resourceId
      ? hasDirectDatabaseViewForResource(scopes, resourceId) &&
          hasScopeForResource(scopes, tool.requiredScope, resourceId)
      : hasDirectDatabaseViewForQueryTool(scopes, tool.requiredScope);
  }
  const anyRequirements = ANY_SCOPE_TOOL_REQUIREMENTS[tool.name];
  if (anyRequirements) return anyRequirements.some((scope) => hasScopeBase(scopes, scope));
  if (DIRECT_DATABASE_VIEW_TOOLS.has(tool.name)) {
    const resourceId = getToolAuthorizationResourceId(tool.name, args);
    if (scopes.includes(tool.requiredScope)) return true;
    return resourceId
      ? scopes.includes(`${tool.requiredScope}:${resourceId}`)
      : scopes.some((scope) => scope.startsWith(`${tool.requiredScope}:`));
  }
  if (DIRECT_RAW_READ_TOOLS.has(tool.name)) {
    const resourceId = getToolAuthorizationResourceId(tool.name, args);
    if (scopes.includes(tool.requiredScope)) return true;
    return resourceId
      ? scopes.includes(`${tool.requiredScope}:${resourceId}`)
      : scopes.some((scope) => scope.startsWith(`${tool.requiredScope}:`));
  }
  if (BROAD_ONLY_TOOL_SCOPES.has(tool.name)) return hasScope(scopes, tool.requiredScope);
  const resourceId = getToolAuthorizationResourceId(tool.name, args);
  return resourceId
    ? hasScopeForResource(scopes, tool.requiredScope, resourceId)
    : hasScopeBase(scopes, tool.requiredScope);
}

function cleanupMcpDiscoveryStates(now = Date.now()): void {
  for (const [key, state] of mcpDiscoveryStates) {
    if (now - state.lastAccessAt > MCP_DISCOVERY_STATE_TTL_MS) {
      mcpDiscoveryStates.delete(key);
    }
  }
}

function mcpDiscoveryStateKey(auth: McpAuthContext): string {
  const authKey = [
    auth.authType ?? 'unknown',
    auth.tokenId || auth.tokenPrefix || 'token',
    auth.clientId ?? 'client',
  ].join(':');
  return auth.mcpSessionId ? `${authKey}:session:${auth.mcpSessionId}` : authKey;
}

function mcpIssuedSessionStateKey(auth: McpAuthContext): string | undefined {
  if (!auth.issuedMcpSessionId || auth.mcpSessionId) return undefined;
  const authKey = [
    auth.authType ?? 'unknown',
    auth.tokenId || auth.tokenPrefix || 'token',
    auth.clientId ?? 'client',
  ].join(':');
  return `${authKey}:session:${auth.issuedMcpSessionId}`;
}

function getMcpDiscoveryState(auth: McpAuthContext): McpDiscoveryState {
  cleanupMcpDiscoveryStates();
  const key = mcpDiscoveryStateKey(auth);
  const existing = mcpDiscoveryStates.get(key);
  if (existing) {
    existing.lastAccessAt = Date.now();
    return existing;
  }
  const state = {
    activeToolsets: new Set(MCP_DEFAULT_TOOLSET_IDS),
    lastAccessAt: Date.now(),
  };
  mcpDiscoveryStates.set(key, state);
  return state;
}

function visibleToolNamesForState(state: McpDiscoveryState): Set<string> {
  const names = new Set<string>(MCP_ALWAYS_VISIBLE_AI_TOOLS);
  for (const id of [...state.activeToolsets].reverse()) {
    const toolset = MCP_TOOLSET_BY_ID.get(id);
    for (const toolName of toolset?.toolNames ?? []) {
      names.add(toolName);
    }
  }
  return names;
}

function toolsetSummary(scopes: string[], state: McpDiscoveryState) {
  return MCP_TOOLSET_DEFINITIONS.map((toolset) => {
    const scopedTools = toolset.toolNames.filter((toolName) => {
      const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
      return tool && isEligibleMcpTool(tool) && hasToolScope(scopes, tool);
    });
    return {
      id: toolset.id,
      title: toolset.title,
      description: toolset.description,
      active: state.activeToolsets.has(toolset.id),
      isDefault: !!toolset.isDefault,
      availableToolCount: scopedTools.length,
      totalToolCount: toolset.toolNames.length,
      tools: scopedTools,
    };
  });
}

function paginateTools<T>(items: T[], cursor: unknown): { items: T[]; nextCursor?: string } {
  const offset = typeof cursor === 'string' && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const page = items.slice(offset, offset + MCP_TOOLS_PAGE_SIZE);
  const nextOffset = offset + MCP_TOOLS_PAGE_SIZE;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function redactToolArgs(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';

  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgs(item, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_TOOL_ARG_RE.test(key) ? '[REDACTED]' : redactToolArgs(nested, depth + 1);
  }
  return redacted;
}

function getToolResourceId(args: Record<string, unknown>): string {
  return String(
    args.caId ||
      args.parentCaId ||
      args.certificateId ||
      args.proxyHostId ||
      args.domainId ||
      args.accessListId ||
      args.templateId ||
      args.userId ||
      args.nodeId ||
      args.containerId ||
      args.deploymentId ||
      args.databaseId ||
      args.ruleId ||
      args.webhookId ||
      ''
  );
}

function getToolAuthorizationResourceId(_toolName: string, args: Record<string, unknown>): string {
  return getToolResourceId(args);
}

async function auditDeniedMcpTool(
  tool: AIToolDefinition | undefined,
  toolName: string,
  auth: McpAuthContext,
  user: User,
  args: Record<string, unknown>,
  reason: string
): Promise<void> {
  const category = tool?.category ?? 'Unknown';
  const redactedArgs = redactToolArgs(args) as Record<string, unknown>;
  setAuditMcpContext({
    toolName,
    category,
    arguments: redactedArgs,
    tokenId: auth.tokenId,
    tokenPrefix: auth.tokenPrefix,
    authType: auth.authType,
    clientId: auth.clientId,
  });

  await container.resolve(AuditService).log({
    userId: user.id,
    action: tool ? `mcp.${toolName}` : 'mcp.tool.denied',
    resourceType: tool ? category.toLowerCase().replace(/\s+/g, '_') : 'mcp_tool',
    resourceId: getToolResourceId(args),
    details: {
      source: 'mcp',
      success: false,
      denied: true,
      reason,
      tokenId: auth.tokenId,
      tokenPrefix: auth.tokenPrefix,
      authType: auth.authType,
      clientId: auth.clientId,
      toolName,
      category,
      requiredScope: tool?.requiredScope,
      arguments: redactedArgs,
    },
  });
}

export function listAvailableMcpTools(scopes: string[], visibleToolNames?: Set<string>): AIToolDefinition[] {
  const tools = AI_TOOLS.filter(
    (tool) =>
      isEligibleMcpTool(tool) && hasToolScope(scopes, tool) && (!visibleToolNames || visibleToolNames.has(tool.name))
  );
  if (!visibleToolNames) return tools;

  const order = new Map([...visibleToolNames].map((name, index) => [name, index]));
  return tools.sort(
    (left, right) =>
      (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.name) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function resetMcpDiscoveryStateForTests(): void {
  mcpDiscoveryStates.clear();
}

function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toolResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null),
      },
    ],
  };
}

export function registerMcpToolHandlers(server: McpAuthContext['server'], auth: McpAuthContext, user: User): void {
  const state = getMcpDiscoveryState(auth);
  server.server.registerCapabilities({ tools: { listChanged: true } });

  server.server.setRequestHandler(ListToolsRequestSchema, (request): ListToolsResult => {
    state.lastAccessAt = Date.now();
    const visibleToolNames = auth.eagerToolListing ? undefined : visibleToolNamesForState(state);
    const tools = [
      ...(auth.eagerToolListing ? [] : [MCP_DISCOVER_TOOLS_DEFINITION]),
      ...listAvailableMcpTools(auth.scopes, visibleToolNames).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters as {
          type: 'object';
          properties?: Record<string, object>;
          required?: string[];
        },
        annotations: {
          readOnlyHint: !tool.destructive && tool.invalidateStores.length === 0,
          destructiveHint: tool.destructive,
        },
        _meta: {
          category: tool.category,
          requiredScope: tool.requiredScope,
        },
      })),
    ];
    const page = paginateTools(tools, request.params?.cursor);

    return { tools: page.items, nextCursor: page.nextCursor };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    if (toolName === 'discover_tools') {
      const category = typeof args.category === 'string' ? args.category : undefined;
      if (category) {
        const toolset = MCP_TOOLSET_BY_ID.get(category);
        if (!toolset) {
          return toolError(`Unknown MCP toolset category "${category}"`);
        }
        state.activeToolsets.delete(category);
        state.activeToolsets.add(category);
        state.lastAccessAt = Date.now();
        const issuedSessionKey = mcpIssuedSessionStateKey(auth);
        if (issuedSessionKey) {
          mcpDiscoveryStates.set(issuedSessionKey, {
            activeToolsets: new Set(state.activeToolsets),
            lastAccessAt: state.lastAccessAt,
          });
        }
        await extra.sendNotification({ method: 'notifications/tools/list_changed' });
      }
      return toolResult({
        activeToolsets: [...state.activeToolsets],
        toolsets: toolsetSummary(auth.scopes, state),
      });
    }

    const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool || !isEligibleMcpTool(tool) || !hasToolScopeForArgs(auth.scopes, tool, args)) {
      await auditDeniedMcpTool(
        tool,
        toolName,
        auth,
        user,
        args,
        tool && isEligibleMcpTool(tool) ? 'missing_scope' : 'unavailable_tool'
      );
      return toolError(`Tool "${toolName}" is unavailable for this MCP token`);
    }

    const result = await container.resolve(AIService).executeTool(user, toolName, args, {
      source: 'mcp',
      scopes: auth.scopes,
      tokenId: auth.tokenId,
      tokenPrefix: auth.tokenPrefix,
      authType: auth.authType,
      clientId: auth.clientId,
    });

    if (result.error) {
      return toolError(result.error);
    }

    return toolResult(result.result);
  });
}
