import { describe, expect, it } from 'vitest';
import { listAvailableMcpTools } from './mcp-tools.js';

function toolNames(scopes: string[]): string[] {
  return listAvailableMcpTools(scopes).map((tool) => tool.name);
}

function toolByName(scopes: string[], name: string) {
  return listAvailableMcpTools(scopes).find((tool) => tool.name === name);
}

describe('MCP tool scope filtering', () => {
  it('requires direct database view before advertising database query tools', () => {
    expect(toolNames(['databases:query:read:db-1'])).not.toContain('query_postgres_read');
    expect(toolNames(['databases:query:read:db-1'])).not.toContain('manage_postgres_data');
    expect(toolNames(['databases:query:read:db-1'])).not.toContain('manage_redis_data');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-2'])).not.toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:write:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:admin:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('manage_postgres_data');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('manage_redis_data');
  });

  it('does not advertise rendered proxy config reads through raw write implication', () => {
    expect(toolNames(['proxy:raw:write:proxy-1'])).not.toContain('get_proxy_rendered_config');
    expect(toolNames(['proxy:raw:read:proxy-1'])).toContain('get_proxy_rendered_config');
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
    expect(toolNames(['proxy:templates:delete:template-1'])).toContain('manage_proxy_template');
    expect(toolNames(['ssl:cert:delete:cert-1'])).toContain('manage_ssl_certificate');
    expect(toolNames(['domains:edit'])).toContain('manage_domain');
    expect(toolNames(['acl:edit:acl-1'])).toContain('manage_access_list');
    expect(toolNames(['docker:registries:delete'])).toContain('manage_docker_registry');
    expect(toolNames(['docker:volumes:delete:node-1'])).toContain('manage_docker_volume');
    expect(toolNames(['docker:networks:edit:node-1'])).toContain('manage_docker_network');
    expect(toolNames(['docker:containers:files:node-1'])).toContain('manage_docker_container_config');
    expect(toolNames(['databases:credentials:reveal:db-1'])).toContain('manage_database_connection');
    expect(toolNames(['logs:read:env-1'])).toContain('manage_logging');
    expect(toolNames(['status-page:incidents:resolve'])).toContain('manage_status_page');
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

  it('never exposes GitLab tools through Gateway MCP', () => {
    const names = toolNames([
      'integrations:gitlab:view',
      'integrations:gitlab:projects:view',
      'integrations:gitlab:repo:read',
      'integrations:gitlab:repo:write',
      'integrations:gitlab:system',
    ]);
    expect(names.some((name) => name.startsWith('gitlab_'))).toBe(false);
  });

  it('never exposes node config or filesystem tools through MCP', () => {
    expect(toolNames(['nodes:config:view', 'nodes:config:edit'])).not.toContain('manage_node_config');
    expect(toolNames(['nodes:files:read', 'nodes:files:write'])).not.toContain('manage_node_file');
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

  it('never exposes browser-session-only current-user tools through MCP', () => {
    expect(toolNames(['feat:ai:use'])).not.toEqual(
      expect.arrayContaining([
        'get_current_context',
        'end_conversation',
        'search_chats',
        'find_in_chat',
        'read_chat_slice',
        'list_chat_projects',
        'manage_ai_conversation',
        'manage_oauth_authorization',
        'manage_api_token',
        'manage_inference_provider',
        'manage_inference_model',
        'manage_inference_limits',
        'manage_inference_token',
      ])
    );
  });

  it('never exposes assistant-only coordination tools through MCP', () => {
    expect(toolNames([])).not.toContain('wait');
    expect(toolByName(['feat:ai:use'], 'wait')).toBeUndefined();
  });

  it('advertises Docker folder tools for every Docker resource view scope', () => {
    expect(toolNames(['docker:containers:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:images:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:networks:view'])).toContain('list_resource_folders');
    expect(toolNames(['docker:volumes:view'])).toContain('list_resource_folders');
  });
});
