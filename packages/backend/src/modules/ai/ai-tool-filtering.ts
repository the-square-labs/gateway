import { getResourceScopedIds, hasScope, hasScopeBase } from '@/lib/permissions.js';
import { FOLDER_TOOL_REQUIREMENT_SCOPES } from './ai.folder-tool-scopes.js';

const BROAD_ONLY_TOOL_SCOPES = new Set<string>();
const DIRECT_DATABASE_VIEW_TOOLS = new Set(['list_databases', 'get_database_connection']);
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
    'feat:ai:use',
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
  manage_domain: ['domains:view', 'domains:edit', 'integrations:cloudflare:dns:view'],
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
  manage_postgres_data: ['databases:query:read', 'databases:query:write'],
  manage_redis_data: ['databases:query:read', 'databases:query:write', 'databases:query:admin'],
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
  manage_inference_provider: ['inference:providers:view', 'inference:providers:manage'],
  manage_inference_token: ['inference:tokens:manage'],
  list_resource_folders: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_resource_folder: [...FOLDER_TOOL_REQUIREMENT_SCOPES],
  manage_node_config: ['nodes:config:view', 'nodes:config:edit'],
  manage_node_file: ['nodes:files:read', 'nodes:files:write'],
};

function hasDirectScopeBase(userScopes: string[], requiredScope: string): boolean {
  return userScopes.includes(requiredScope) || userScopes.some((scope) => scope.startsWith(`${requiredScope}:`));
}

function getDirectResourceScopedIds(userScopes: string[], baseScope: string): string[] {
  return userScopes
    .filter((scope) => scope.startsWith(`${baseScope}:`) && scope.length > baseScope.length + 1)
    .map((scope) => scope.slice(baseScope.length + 1));
}

function hasDirectDatabaseViewForQueryTool(userScopes: string[], queryScope: string): boolean {
  if (!hasScopeBase(userScopes, queryScope) || !hasDirectScopeBase(userScopes, 'databases:view')) return false;
  if (userScopes.includes('databases:view') || hasScope(userScopes, queryScope)) return true;

  const queryIds = new Set(getResourceScopedIds(userScopes, queryScope));
  return getDirectResourceScopedIds(userScopes, 'databases:view').some((databaseId) => queryIds.has(databaseId));
}

function hasAnyRequiredToolScope(userScopes: string[], toolName: string): boolean {
  const requirements = ANY_SCOPE_TOOL_REQUIREMENTS[toolName];
  return !!requirements && requirements.some((scope) => hasScopeBase(userScopes, scope));
}

export function canUseAiTool(toolName: string, requiredScope: string | undefined, userScopes: string[]) {
  if (!requiredScope) return false;
  if (DIRECT_DATABASE_VIEW_AND_QUERY_TOOLS.has(toolName)) {
    return hasDirectDatabaseViewForQueryTool(userScopes, requiredScope);
  }
  if (ANY_SCOPE_TOOL_REQUIREMENTS[toolName]) return hasAnyRequiredToolScope(userScopes, toolName);
  if (DIRECT_DATABASE_VIEW_TOOLS.has(toolName)) return hasDirectScopeBase(userScopes, requiredScope);
  return BROAD_ONLY_TOOL_SCOPES.has(toolName)
    ? hasScope(userScopes, requiredScope)
    : hasScopeBase(userScopes, requiredScope);
}
