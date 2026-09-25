import { describe, expect, it } from 'vitest';
import { listAvailableMcpTools } from './mcp-tools.js';

function toolNames(scopes: string[]): string[] {
  return listAvailableMcpTools(scopes).map((tool) => tool.name);
}

function toolByName(scopes: string[], name: string) {
  return listAvailableMcpTools(scopes).find((tool) => tool.name === name);
}

describe('MCP tool scope filtering', () => {
  it('exposes object streaming only to storage writers through MCP with bounded chunks', () => {
    const tool = toolByName(['storage:objects:write:storage-1'], 'upload_storage_object');
    expect(tool?.mcpOnly).toBe(true);
    expect(tool?.historyRetention).toEqual({ mode: 'never_full' });
    expect(tool?.parameters.properties).toHaveProperty('contentBase64');
    expect(tool?.parameters.properties).not.toHaveProperty('token');
    expect(toolNames(['storage:objects:read:storage-1'])).not.toContain('upload_storage_object');
  });
  it('advertises database tools for the same implied scopes as the database routes', () => {
    // A query grant implies viewing its database, like GET /databases and the query routes.
    expect(toolNames(['databases:query:read:db-1'])).toEqual(
      expect.arrayContaining([
        'list_databases',
        'get_database_connection',
        'query_postgres_read',
        'manage_postgres_data',
        'manage_redis_data',
      ])
    );
    expect(toolNames(['databases:view:db-1'])).not.toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:write:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:admin:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('manage_postgres_data');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('manage_redis_data');
  });

  it('does not advertise rendered proxy config reads through raw write implication', () => {
    expect(toolNames(['proxy:raw:write:proxy-1'])).not.toContain('get_route_rendered_config');
    expect(toolNames(['proxy:raw:read:proxy-1'])).toContain('get_route_rendered_config');
  });

  it('advertises registry selection for Docker create and pull tools', () => {
    const createTool = toolByName(['docker:containers:create'], 'create_docker_container');
    const pullTool = toolByName(['docker:images:pull'], 'pull_docker_image');

    expect(createTool?.parameters.properties).toHaveProperty('registryId');
    expect(pullTool?.parameters.properties).toHaveProperty('registryId');
  });

  it('advertises aggregated MCP tools through any matching delegated scope', () => {
    expect(toolNames(['pki:cert:export:cert-1'])).toContain('manage_certificate');
    expect(toolNames(['pki:templates:edit'])).toContain('manage_template');
    expect(toolNames(['proxy:templates:manage:template-1'])).toContain('manage_proxy_template');
    expect(toolNames(['ssl:cert:delete:cert-1'])).toContain('manage_ssl_certificate');
    expect(toolNames(['domains:edit'])).toContain('manage_domain');
    expect(toolNames(['acl:edit:acl-1'])).toContain('manage_access_list');
    expect(toolNames(['docker:registries:delete'])).toContain('manage_docker_registry');
    expect(toolNames(['docker:volumes:delete:node-1'])).toContain('manage_docker_volume');
    expect(toolNames(['docker:networks:edit:node-1'])).toContain('manage_docker_network');
    expect(toolNames(['docker:containers:files:read:node-1'])).toContain('manage_docker_container_config');
    expect(toolNames(['docker:compose:view:node-1/project-1'])).toEqual(
      expect.arrayContaining([
        'manage_docker_compose',
        'list_docker_builds',
        'manage_docker_build',
        'manage_docker_source',
      ])
    );
    expect(toolNames(['databases:credentials:reveal:db-1'])).toContain('manage_database_connection');
    expect(toolNames(['logs:read:env-1'])).toContain('manage_logging');
    expect(toolNames(['status-page:incidents:resolve'])).toContain('manage_status_page');
    expect(toolNames(['pages:tokens:manage:project-1'])).toContain('manage_pages');
    expect(toolNames(['pages:deploy:project-1'])).toContain('upload_pages_artifact');
  });

  it('exposes scoped internal documentation through the MCP-only documentation tool', () => {
    const tool = toolByName(['nodes:details'], 'read_gateway_documentation');

    expect(tool?.mcpOnly).toBe(true);
    expect(tool?.parameters.properties).toHaveProperty('topic');
    expect(toolNames(['nodes:details'])).not.toContain('internal_documentation');
  });

  it('advertises Pages upload as an MCP-only resumable binary contract', () => {
    const tool = toolByName(['pages:deploy:project-1'], 'upload_pages_artifact');

    expect(tool?.mcpOnly).toBe(true);
    expect(tool?.parameters.properties).toHaveProperty('contentBase64');
    expect(tool?.parameters.properties).not.toHaveProperty('token');
    expect(tool?.parameters.properties).not.toHaveProperty('authorization');
  });

  it('never exposes AI sandbox runner tools through MCP', () => {
    const sandboxToolNames = [
      'execute_script',
      'run_process',
      'fetch',
      'download_artifact',
      'read_artifact',
      'send_artifact',
      'read_process_output',
      'write_process_stdin',
      'kill_process',
      'list_sandbox_jobs',
    ];

    expect(toolNames(['ai:sandbox:use', 'ai:sandbox:tier:medium', 'ai:sandbox:tier:high'])).not.toEqual(
      expect.arrayContaining(sandboxToolNames)
    );
  });

  it('exposes GitLab tools through delegated GitLab scopes but never the AI sandbox clone', () => {
    const names = toolNames([
      'integrations:gitlab:view',
      'integrations:gitlab:manage',
      'integrations:gitlab:repo:read',
      'integrations:gitlab:repo:write',
      'integrations:gitlab:sandbox:clone',
      'ai:sandbox:use',
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        'gitlab_list_connectors',
        'gitlab_list_projects',
        'gitlab_read_file',
        'gitlab_commit_files',
        'gitlab_list_pipelines',
        'gitlab_set_project_variable',
        'create_gitlab_connector',
      ])
    );
    expect(names).not.toContain('gitlab_clone_repository_to_sandbox');
  });

  it('exposes GitHub, generic Git, Cloudflare, and external SSH connector tools but not setup dialogs', () => {
    const names = toolNames([
      'feat:ai:use',
      'ai:workspace:use',
      'integrations:github:view',
      'integrations:github:manage',
      'integrations:github:repo:read',
      'integrations:github:repo:write',
      'integrations:git:view',
      'integrations:git:manage',
      'integrations:git:repo:read',
      'integrations:git:repo:write',
      'integrations:cloudflare:manage',
      'integrations:ssh:view',
      'integrations:ssh:use',
      'integrations:ssh:manage',
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        'github_list_connectors',
        'github_list_repositories',
        'github_list_repository_tree',
        'github_list_branches',
        'github_list_workflow_runs',
        'github_list_actions_variables',
        'github_list_actions_secrets',
        'github_upsert_repository_file',
        'github_upsert_actions_variable',
        'github_upsert_actions_secret',
        'create_github_token_connector',
        'git_list_connectors',
        'git_list_remote_refs',
        'git_list_repository_tree',
        'git_read_repository_file',
        'git_upsert_repository_file',
        'create_git_connector',
        'create_cloudflare_connector',
        'ssh_list_connectors',
        'ssh_execute_command',
        'create_ssh_connector',
      ])
    );
    expect(names).not.toContain('open_connector_setup');
    expect(names).not.toContain('open_node_enrollment');
    // Repository content follows the repo verbs, not connector administration.
    const connectorAdmin = toolNames(['integrations:github:manage', 'integrations:git:manage']);
    expect(connectorAdmin).toContain('create_github_token_connector');
    expect(connectorAdmin).not.toContain('github_upsert_repository_file');
    expect(connectorAdmin).not.toContain('git_upsert_repository_file');
    const readers = toolNames(['integrations:github:repo:read', 'integrations:git:repo:read']);
    expect(readers).toEqual(expect.arrayContaining(['github_read_repository_file', 'git_read_repository_file']));
    expect(readers).not.toContain('github_upsert_repository_file');
    // CI/CD variable values are secrets: reading them is part of the write tier.
    expect(readers).not.toContain('github_list_actions_variables');
    // GitLab variable listing returns keys and flags only, never values.
    expect(toolNames(['integrations:gitlab:repo:read'])).toContain('gitlab_list_project_variables');
    expect(toolNames(['integrations:github:repo:write'])).toContain('github_list_actions_variables');
  });

  it('exposes node config and filesystem tools through their node scopes', () => {
    expect(toolNames(['nodes:config:view:node-1'])).toContain('manage_node_config');
    expect(toolNames(['nodes:files:read:node-1'])).toContain('manage_node_file');
    expect(toolNames(['nodes:details'])).not.toContain('manage_node_config');
    expect(toolNames(['nodes:details'])).not.toContain('manage_node_file');
  });

  it('exposes inference administration and personal inference key tools', () => {
    const names = toolNames([
      'inference:providers:view',
      'inference:providers:manage',
      'inference:models:manage',
      'inference:limits:manage',
      'feat:ai:use',
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        'manage_inference_provider',
        'manage_inference_model',
        'manage_inference_limits',
        'manage_inference_token',
      ])
    );
    expect(toolNames(['inference:providers:view'])).not.toContain('manage_inference_token');
  });

  it('exposes administration and gateway settings tools through their delegated scopes', () => {
    const names = toolNames(['admin:users', 'admin:groups', 'settings:gateway:view', 'settings:gateway:edit']);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_users',
        'create_user',
        'update_user_role',
        'list_groups',
        'create_group',
        'get_gateway_settings',
        'update_gateway_settings',
        'manage_logging_backend',
      ])
    );
  });

  it('exposes console tools only when their opt-in console scopes are delegated', () => {
    expect(toolNames(['nodes:details'])).not.toContain('execute_node_console_command');
    expect(toolNames(['nodes:console'])).toContain('execute_node_console_command');
    expect(toolByName(['nodes:console'], 'execute_node_console_command')?.destructive).toBe(true);

    expect(toolNames(['docker:containers:view'])).not.toContain('execute_docker_container_console_command');
    expect(toolNames(['docker:containers:console:node-1'])).toContain('execute_docker_container_console_command');
    expect(
      toolByName(['docker:containers:console:node-1'], 'execute_docker_container_console_command')?.destructive
    ).toBe(true);
  });

  it('never exposes AI chat internals, Gateway token minting, or UI-only tools through MCP', () => {
    const names = toolNames(['feat:ai:use', 'ai:workspace:use']);
    for (const name of [
      'get_current_context',
      'end_conversation',
      'search_chats',
      'search_compacted_history',
      'find_in_chat',
      'read_chat_slice',
      'list_chat_projects',
      'manage_ai_conversation',
      'manage_oauth_authorization',
      'manage_api_token',
      'open_node_enrollment',
      'open_connector_setup',
      'set_resource_pin',
      'ask_question',
      'send_comment',
      'wait',
    ]) {
      expect(names, name).not.toContain(name);
    }
  });

  it('keeps assistant-only coordination tools hidden while exposing supported resource lifecycles', () => {
    expect(toolNames([])).not.toContain('wait');
    expect(toolByName(['feat:ai:use'], 'wait')).toBeUndefined();
    const resourceSetupScopes = [
      'databases:view',
      'databases:create',
      'docker:containers:migrate',
      'docker:tasks',
      'settings:gateway:view',
      'settings:gateway:edit',
    ];
    expect(toolNames(resourceSetupScopes)).toEqual(
      expect.arrayContaining(['manage_managed_database', 'manage_docker_migration', 'manage_logging_backend'])
    );
    expect(toolNames(['pages:view'])).toContain('manage_pages');
    const managedStorage = toolByName(['storage:iam:storage-1'], 'manage_managed_storage');
    expect(managedStorage).toBeDefined();
    expect(managedStorage?.parameters).toMatchObject({
      properties: {
        action: { enum: expect.arrayContaining(['list_access_keys', 'create_access_key', 'remove_access_key']) },
      },
    });
    expect(toolNames(['proxy:view'])).toEqual(
      expect.arrayContaining(['manage_additional_route', 'manage_additional_secure_link'])
    );
  });

  it('advertises Docker folder tools for every Docker resource view scope', () => {
    expect(toolNames(['docker:containers:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:images:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:networks:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:volumes:view'])).toContain('list_resource_folders');
  });
});
