import { container } from '@/container.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { assertConnectorOperationAccess } from '@/modules/integrations/integration-permissions.js';
import type {
  GitConnectorCreateInput,
  GitHubConnectorCreateInput,
} from '@/modules/integrations/integrations.schemas.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { User } from '@/types.js';

const CONNECTOR_PROVIDERS = ['gitlab', 'github', 'git', 'cloudflare', 'ssh'] as const;
type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

interface ConnectorRouteAccess {
  operation: string;
  requiredScope: string | readonly string[];
}

/**
 * Mirrors the connector list middleware in integrations.routes.ts. Git and SSH
 * routes name the operation after the HTTP method (`connector.get`).
 */
const CONNECTOR_LIST_ACCESS: Record<ConnectorProvider, ConnectorRouteAccess> = {
  gitlab: { operation: 'connector.list', requiredScope: ['integrations:gitlab:view', 'integrations:gitlab:manage'] },
  cloudflare: {
    operation: 'connector.list',
    requiredScope: ['integrations:cloudflare:view', 'integrations:cloudflare:manage'],
  },
  github: { operation: 'connector.get', requiredScope: ['integrations:github:view', 'integrations:github:manage'] },
  git: { operation: 'connector.get', requiredScope: ['integrations:git:view', 'integrations:git:manage'] },
  ssh: { operation: 'connector.get', requiredScope: ['integrations:ssh:view', 'integrations:ssh:manage'] },
};

/**
 * Mirrors the connector sync middleware in integrations.routes.ts
 * (`POST /:provider/connectors/:id/sync`). Hosting connectors are left out:
 * their sync route is session-only. Per-user Git credential routes are
 * session-only too, and no sync below reads or writes them.
 */
const CONNECTOR_SYNC_ACCESS: Record<ConnectorProvider, ConnectorRouteAccess> = {
  gitlab: { operation: 'connector.sync', requiredScope: ['integrations:gitlab:sync', 'integrations:gitlab:manage'] },
  cloudflare: {
    operation: 'connector.sync',
    requiredScope: ['integrations:cloudflare:sync', 'integrations:cloudflare:manage'],
  },
  github: { operation: 'connector.post', requiredScope: ['integrations:github:sync', 'integrations:github:manage'] },
  git: { operation: 'connector.post', requiredScope: ['integrations:git:sync', 'integrations:git:manage'] },
  // The SSH "sync" route authenticates to the host with the stored credential; it has no sync scope.
  ssh: { operation: 'connector.post', requiredScope: 'integrations:ssh:manage' },
};

export const INTEGRATION_TOOL_NAMES = new Set([
  'github_list_connectors',
  'git_list_connectors',
  'github_list_repositories',
  'github_list_repository_tree',
  'github_read_repository_file',
  'github_list_branches',
  'github_list_workflow_runs',
  'github_list_actions_variables',
  'github_list_actions_secrets',
  'github_upsert_repository_file',
  'github_upsert_actions_variable',
  'github_upsert_actions_secret',
  'git_list_remote_refs',
  'git_list_repository_tree',
  'git_read_repository_file',
  'git_upsert_repository_file',
  'create_github_token_connector',
  'create_git_connector',
  'create_gitlab_connector',
  'create_cloudflare_connector',
  'list_integration_connectors',
  'sync_integration_connector',
]);

export async function executeIntegrationTool(user: User, toolName: string, args: Record<string, unknown>) {
  const service = container.resolve(IntegrationsService);
  const a = args as Record<string, unknown>;
  if (toolName === 'list_integration_connectors') return listIntegrationConnectors(service, user, a);
  if (toolName === 'sync_integration_connector') return syncIntegrationConnector(service, user, a);
  if (toolName === 'github_list_connectors') return service.listGitConnectors('github', true);
  if (toolName === 'git_list_connectors') return service.listGitConnectors('git', true);
  if (toolName === 'github_list_repositories') {
    return service.githubListRepositories(user, { connectorId: requiredString(a.connectorId) });
  }
  if (toolName === 'github_list_repository_tree') {
    return service.githubListRepositoryTree(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: optionalString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'github_read_repository_file') {
    return service.githubReadRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'github_list_branches') {
    return service.githubListBranches(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_list_workflow_runs') {
    return service.githubListWorkflowRuns(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      branch: optionalString(a.branch),
      status: optionalString(a.status),
    });
  }
  if (toolName === 'github_list_actions_variables') {
    return service.githubListActionsVariables(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_list_actions_secrets') {
    return service.githubListActionsSecrets(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'github_upsert_repository_file') {
    return service.githubUpsertRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      branch: requiredString(a.branch),
      message: requiredString(a.message),
      content: typeof a.content === 'string' ? a.content : requiredString(a.content),
    });
  }
  if (toolName === 'github_upsert_actions_variable') {
    return service.githubUpsertActionsVariable(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      name: requiredString(a.name),
      value: typeof a.value === 'string' ? a.value : requiredString(a.value),
    });
  }
  if (toolName === 'github_upsert_actions_secret') {
    return service.githubUpsertActionsSecret(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      name: requiredString(a.name),
      value: typeof a.value === 'string' ? a.value : requiredString(a.value),
    });
  }
  if (toolName === 'git_list_remote_refs') {
    return service.gitListRemoteRefs(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
    });
  }
  if (toolName === 'git_list_repository_tree') {
    return service.gitListRepositoryTree(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: optionalString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'git_read_repository_file') {
    return service.gitReadRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      ref: optionalString(a.ref),
    });
  }
  if (toolName === 'git_upsert_repository_file') {
    return service.gitUpsertRepositoryFile(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
      path: requiredString(a.path),
      branch: requiredString(a.branch),
      message: requiredString(a.message),
      content: typeof a.content === 'string' ? a.content : requiredString(a.content),
    });
  }
  if (toolName === 'create_gitlab_connector') {
    return service.createGitLabConnector(
      {
        name: requiredString(a.name),
        baseUrl: requiredString(a.baseUrl),
        enabled: true,
        token: requiredString(a.token),
        allowlistMode: 'all_visible',
      },
      user.id
    );
  }
  if (toolName === 'create_cloudflare_connector') {
    return service.createCloudflareConnector(
      { name: requiredString(a.name), enabled: true, token: requiredString(a.token) },
      user.id
    );
  }
  if (toolName === 'create_github_token_connector') {
    const input: GitHubConnectorCreateInput = {
      name: requiredString(a.name),
      baseUrl: requiredString(a.baseUrl),
      enabled: true,
      authMode: 'token',
      token: requiredString(a.token),
    };
    return service.createGitConnector('github', input, user.id);
  }
  if (toolName === 'create_git_connector') {
    const repositoryUrls = Array.isArray(a.repositoryUrls)
      ? a.repositoryUrls.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const input: GitConnectorCreateInput = {
      name: requiredString(a.name),
      baseUrl: requiredString(a.baseUrl),
      enabled: true,
      authMode: 'token',
      username: optionalString(a.username),
      token: requiredString(a.token),
      allowlistEntries: repositoryUrls.map((url) => ({
        entryType: 'project',
        remoteId: url,
        fullPath: url,
        name: url,
        webUrl: url,
      })),
    };
    if (repositoryUrls.length === 0) throw new Error('repositoryUrls is required');
    return service.createGitConnector('git', input, user.id);
  }
  throw new Error(`Unsupported integration tool: ${toolName}`);
}

function assertConnectorRouteAccess(
  user: User,
  provider: ConnectorProvider,
  connectorId: string | null,
  access: ConnectorRouteAccess
) {
  assertConnectorOperationAccess({
    actor: { userId: user.id, scopes: user.scopes },
    provider,
    connectorId,
    operation: access.operation,
    requiredScope: access.requiredScope,
  });
}

function connectorProvider(value: unknown): ConnectorProvider {
  if (CONNECTOR_PROVIDERS.includes(value as ConnectorProvider)) return value as ConnectorProvider;
  throw new AppError(400, 'INVALID_CONNECTOR_PROVIDER', `provider must be one of: ${CONNECTOR_PROVIDERS.join(', ')}`);
}

function canListConnectorProvider(user: User, provider: ConnectorProvider): boolean {
  const { requiredScope } = CONNECTOR_LIST_ACCESS[provider];
  const scopes = typeof requiredScope === 'string' ? [requiredScope] : requiredScope;
  return scopes.some((scope) => hasScope(user.scopes, scope));
}

interface ListedConnectorRow {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  authMode?: string;
  syncStatus: string;
  syncLastError: string | null;
  syncFinishedAt: Date | null;
  testedAt: Date | null;
}

function compactConnector(provider: ConnectorProvider, row: ListedConnectorRow) {
  return {
    provider,
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    authMode: row.authMode,
    syncStatus: row.syncStatus,
    syncLastError: row.syncLastError,
    syncFinishedAt: row.syncFinishedAt,
    testedAt: row.testedAt,
  };
}

async function listProviderConnectors(
  service: IntegrationsService,
  user: User,
  provider: ConnectorProvider,
  enabled: boolean | undefined
) {
  switch (provider) {
    case 'gitlab':
      return (await service.listGitLabConnectors({ enabled })).map((row) => compactConnector(provider, row));
    case 'cloudflare':
      return (await service.listCloudflareConnectors({ enabled })).map((row) => ({
        ...compactConnector(provider, row),
        zoneCount: row.zones.length,
      }));
    case 'github':
    case 'git':
      return (await service.listGitConnectors(provider, enabled)).map((row) => ({
        ...compactConnector(provider, row),
        repositoryCount: row.allowlistEntries.length,
      }));
    case 'ssh':
      return (await container.resolve(ExternalSshService).list(user))
        .filter((row) => enabled === undefined || row.enabled === enabled)
        .map((row) => ({
          provider,
          id: row.id,
          name: row.name,
          host: row.host,
          port: row.port,
          enabled: row.enabled,
          testStatus: row.testStatus,
          testLastError: row.testLastError,
          testedAt: row.testedAt,
        }));
  }
}

async function listIntegrationConnectors(service: IntegrationsService, user: User, args: Record<string, unknown>) {
  const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
  if (args.provider !== undefined) {
    const provider = connectorProvider(args.provider);
    assertConnectorRouteAccess(user, provider, null, CONNECTOR_LIST_ACCESS[provider]);
    return { connectors: await listProviderConnectors(service, user, provider, enabled) };
  }

  const connectors: Array<Record<string, unknown>> = [];
  const unavailableProviders: Array<{ provider: ConnectorProvider; error: string }> = [];
  for (const provider of CONNECTOR_PROVIDERS) {
    if (!canListConnectorProvider(user, provider)) continue;
    assertConnectorRouteAccess(user, provider, null, CONNECTOR_LIST_ACCESS[provider]);
    try {
      connectors.push(...(await listProviderConnectors(service, user, provider, enabled)));
    } catch (error) {
      unavailableProviders.push({ provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return unavailableProviders.length > 0 ? { connectors, unavailableProviders } : { connectors };
}

async function syncIntegrationConnector(service: IntegrationsService, user: User, args: Record<string, unknown>) {
  const provider = connectorProvider(args.provider);
  const connectorId = requiredString(args.connectorId);
  assertConnectorRouteAccess(user, provider, connectorId, CONNECTOR_SYNC_ACCESS[provider]);
  switch (provider) {
    case 'gitlab':
      return { provider, connectorId, result: await service.syncGitLabConnector(connectorId, user.id) };
    case 'cloudflare':
      return { provider, connectorId, result: await service.syncCloudflareConnector(connectorId, user.id) };
    case 'github':
    case 'git': {
      const synced = await service.syncGitConnector(provider, connectorId, user.id);
      return {
        provider,
        connectorId,
        result: { ...compactConnector(provider, synced), repositoryCount: synced.allowlistEntries.length },
      };
    }
    case 'ssh':
      return { provider, connectorId, result: await container.resolve(ExternalSshService).test(user, connectorId) };
  }
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new Error('Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
