import { container } from '@/container.js';
import type {
  GitConnectorCreateInput,
  GitHubConnectorCreateInput,
} from '@/modules/integrations/integrations.schemas.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import type { User } from '@/types.js';

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
]);

export async function executeIntegrationTool(user: User, toolName: string, args: Record<string, unknown>) {
  const service = container.resolve(IntegrationsService);
  const a = args as Record<string, unknown>;
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

function requiredString(value: unknown): string {
  const text = optionalString(value);
  if (!text) throw new Error('Required value is missing');
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
