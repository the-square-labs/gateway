import { container } from '@/container.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { GitConnectorCreateInput } from '@/modules/integrations/integrations.schemas.js';
import type { User } from '@/types.js';

export const INTEGRATION_TOOL_NAMES = new Set([
  'github_list_connectors',
  'git_list_connectors',
  'github_list_repository_tree',
  'github_read_repository_file',
  'github_upsert_repository_file',
  'git_list_remote_refs',
  'create_github_token_connector',
  'create_git_connector',
  'create_gitlab_connector',
  'create_cloudflare_connector',
]);

export async function executeIntegrationTool(user: User, toolName: string, args: Record<string, unknown>) {
  const service = container.resolve(IntegrationsService);
  const a = args as Record<string, unknown>;
  if (toolName === 'github_list_connectors') return service.listGitConnectors('github', true);
  if (toolName === 'git_list_connectors') return service.listGitConnectors('git', true);
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
  if (toolName === 'git_list_remote_refs') {
    return service.gitListRemoteRefs(user, {
      connectorId: requiredString(a.connectorId),
      repositoryUrl: requiredString(a.repositoryUrl),
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
  if (toolName === 'create_github_token_connector' || toolName === 'create_git_connector') {
    const provider = toolName === 'create_git_connector' ? 'git' : 'github';
    const mode = a.repositoryMode === 'multi_repository' ? 'multi_repository' : 'single_repository';
    const repositoryUrl = optionalString(a.repositoryUrl);
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
      repositoryMode: mode,
      repositoryUrl,
      allowlistEntries:
        mode === 'multi_repository'
          ? repositoryUrls.map((url) => ({
              entryType: 'project',
              remoteId: url,
              fullPath: url,
              name: url,
              webUrl: url,
            }))
          : undefined,
    };
    if (mode === 'single_repository' && !repositoryUrl) throw new Error('repositoryUrl is required');
    if (mode === 'multi_repository' && repositoryUrls.length === 0) throw new Error('repositoryUrls is required');
    return service.createGitConnector(provider, input, user.id);
  }
  throw new Error(`Unsupported integration tool: ${toolName}`);
}

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new Error('Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
