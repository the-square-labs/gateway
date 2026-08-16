import { describe, expect, it } from 'vitest';
import {
  AI_TOOLS,
  getOpenAITools,
  inferDiscoveredToolsetsFromText,
  isDestructiveTool,
  parseAndValidateAIToolArguments,
  TOOL_STORE_INVALIDATION_MAP,
} from './ai.tools.js';

function toolNames(scopes: string[]): string[] {
  return getOpenAITools([], scopes, false).map((tool) => tool.function.name);
}

function notificationToolNamesForScopes(scopes: string[]): string[] {
  const notificationToolNames = new Set(
    AI_TOOLS.filter((tool) => tool.category === 'Notifications').map((tool) => tool.name)
  );
  return toolNames(scopes).filter((name) => notificationToolNames.has(name));
}

function databaseToolNamesForScopes(scopes: string[]): string[] {
  const databaseToolNames = new Set(AI_TOOLS.filter((tool) => tool.category === 'Databases').map((tool) => tool.name));
  return toolNames(scopes).filter((name) => databaseToolNames.has(name));
}

function dockerToolNamesForScopes(scopes: string[]): string[] {
  const dockerToolNames = new Set(AI_TOOLS.filter((tool) => tool.category === 'Docker').map((tool) => tool.name));
  return toolNames(scopes).filter((name) => dockerToolNames.has(name));
}

function sandboxToolNamesForScopes(scopes: string[], sandboxEnabled: boolean): string[] {
  const sandboxToolNames = new Set(AI_TOOLS.filter((tool) => tool.category === 'Sandbox').map((tool) => tool.name));
  return getOpenAITools([], scopes, false, { sandboxEnabled })
    .map((tool) => tool.function.name)
    .filter((name) => sandboxToolNames.has(name));
}

describe('AI tool scope filtering', () => {
  it('compiles every registered JSON schema and rejects malformed or non-object arguments', () => {
    expect(parseAndValidateAIToolArguments('get_current_context', '{}')).toEqual({ ok: true, arguments: {} });
    expect(parseAndValidateAIToolArguments('get_current_context', '{')).toEqual({
      ok: false,
      error: 'Invalid tool arguments: malformed JSON',
    });
    expect(parseAndValidateAIToolArguments('get_current_context', 'null')).toEqual({
      ok: false,
      error: 'Invalid tool arguments: expected a JSON object',
    });
    expect(parseAndValidateAIToolArguments('get_current_context', '[]')).toEqual({
      ok: false,
      error: 'Invalid tool arguments: expected a JSON object',
    });
  });

  it('returns path-only schema failures and rejects unknown tools', () => {
    expect(parseAndValidateAIToolArguments('send_comment', '{}')).toEqual({
      ok: false,
      error: 'Invalid tool arguments at $/message',
    });
    expect(parseAndValidateAIToolArguments('does_not_exist', '{}')).toEqual({
      ok: false,
      error: 'Unknown AI tool: does_not_exist',
    });
  });

  it('exposes concrete connector and node setup handoffs without the Finalize Setup route', () => {
    expect(toolNames(['feat:ai:use'])).toEqual(
      expect.arrayContaining(['open_connector_setup', 'open_node_enrollment'])
    );
    expect(
      parseAndValidateAIToolArguments(
        'open_connector_setup',
        JSON.stringify({
          connector: 'git',
          baseUrl: 'https://git.example.test',
          repositoryUrl: 'https://git.example.test/team/api',
        })
      )
    ).toMatchObject({
      ok: true,
      arguments: {
        connector: 'git',
        repositoryUrl: 'https://git.example.test/team/api',
      },
    });
    expect(
      parseAndValidateAIToolArguments(
        'open_connector_setup',
        JSON.stringify({ connector: 'ssh', host: 'server.example.test' })
      )
    ).toMatchObject({
      ok: true,
      arguments: { connector: 'ssh', host: 'server.example.test' },
    });
    expect(parseAndValidateAIToolArguments('open_connector_setup', JSON.stringify({ connector: 'svn' }))).toEqual({
      ok: false,
      error: 'Invalid tool arguments at /connector',
    });
  });

  it('exposes guarded resource setup tools to the native assistant', () => {
    const names = toolNames([
      'databases:view',
      'databases:create',
      'docker:containers:migrate',
      'settings:gateway:view',
      'settings:gateway:edit',
    ]);
    expect(names).toEqual(
      expect.arrayContaining(['manage_managed_database', 'manage_docker_migration', 'manage_logging_backend'])
    );
    expect(
      parseAndValidateAIToolArguments(
        'manage_managed_database',
        JSON.stringify({ operation: 'create', type: 'postgres', name: 'app-db' })
      )
    ).toMatchObject({ ok: true });
    expect(parseAndValidateAIToolArguments('manage_docker_migration', '{"operation":"invent"}')).toEqual({
      ok: false,
      error: 'Invalid tool arguments at /operation',
    });
  });

  it('exposes only planning-safe tools while keeping read variants of composite tools available', () => {
    const names = getOpenAITools(
      [],
      [
        'feat:ai:use',
        'domains:view',
        'domains:manage',
        'integrations:github:view',
        'integrations:github:manage',
        'integrations:git:view',
        'integrations:git:manage',
        'integrations:ssh:view',
        'integrations:ssh:use',
      ],
      true,
      {
        discoveredToolsets: ['Domains', 'GitHub', 'Git', 'External SSH', 'Setup'],
        planningMode: true,
      }
    ).map((tool) => tool.function.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'enter_plan_mode',
        'submit_plan',
        'manage_domain',
        'open_connector_setup',
        'github_list_repositories',
        'github_list_repository_tree',
        'github_list_workflow_runs',
        'git_list_repository_tree',
        'git_read_repository_file',
        'ssh_list_connectors',
      ])
    );
    expect(names).not.toContain('create_domain');
    expect(names).not.toContain('delete_domain');
    expect(names).not.toContain('github_upsert_repository_file');
    expect(names).not.toContain('github_upsert_actions_secret');
    expect(names).not.toContain('git_upsert_repository_file');
    expect(names).not.toContain('ssh_execute_command');
  });

  it('derives active plan lifecycle identifiers on the server instead of asking the model to copy them', () => {
    for (const toolName of ['submit_plan_review', 'update_plan_step', 'submit_plan_verification']) {
      const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool?.parameters.properties).not.toHaveProperty('planId');
      expect(tool?.parameters.properties).not.toHaveProperty('revisionId');
      expect(tool?.parameters.properties).not.toHaveProperty('stepId');
    }
    expect(AI_TOOLS.find((tool) => tool.name === 'submit_plan_review')?.parameters.required).toEqual([
      'intentReview',
      'securityReview',
    ]);
    expect(AI_TOOLS.find((tool) => tool.name === 'update_plan_step')?.parameters.required).toEqual(['status']);
    expect(AI_TOOLS.find((tool) => tool.name === 'submit_plan_verification')?.parameters.required).toEqual([
      'verdict',
      'summary',
      'findings',
    ]);
  });

  it('rejects unsupported composite resource and operation pairs before dispatch', () => {
    expect(
      parseAndValidateAIToolArguments(
        'manage_status_page',
        JSON.stringify({ resource: 'proxy_templates', operation: 'delete' })
      )
    ).toEqual({
      ok: false,
      error: 'Invalid tool arguments at $/resource, $/operation',
    });
    expect(
      parseAndValidateAIToolArguments(
        'manage_status_page',
        JSON.stringify({ resource: 'proxy_templates', operation: 'list' })
      )
    ).toMatchObject({ ok: true });
  });

  it('keeps core registry ordering, uniqueness, and invalidation contracts stable', () => {
    expect(new Set(AI_TOOLS.map((tool) => tool.name)).size).toBe(AI_TOOLS.length);
    expect(AI_TOOLS.slice(0, 90).map((tool) => tool.name)).toEqual([
      'discover_tools',
      'read_skill',
      'activate_skill',
      'get_current_context',
      'read_tool_output',
      'search_tool_output',
      'wait',
      'send_comment',
      'end_conversation',
      'find_resource',
      'search_chats',
      'search_compacted_history',
      'find_in_chat',
      'read_chat_slice',
      'list_chat_projects',
      'audit_system_pki_leaves',
      'list_cas',
      'get_ca',
      'create_root_ca',
      'create_intermediate_ca',
      'delete_ca',
      'manage_ca',
      'list_certificates',
      'get_certificate',
      'issue_certificate',
      'revoke_certificate',
      'manage_certificate',
      'list_templates',
      'create_template',
      'delete_template',
      'manage_template',
      'list_resource_folders',
      'manage_resource_folder',
      'list_proxy_hosts',
      'get_proxy_host',
      'create_proxy_host',
      'update_proxy_host',
      'delete_proxy_host',
      'create_proxy_folder',
      'move_hosts_to_folder',
      'delete_proxy_folder',
      'manage_proxy_template',
      'list_ssl_certificates',
      'request_acme_cert',
      'link_internal_cert',
      'manage_ssl_certificate',
      'list_domains',
      'create_domain',
      'delete_domain',
      'manage_domain',
      'list_access_lists',
      'create_access_list',
      'delete_access_list',
      'manage_access_list',
      'list_nodes',
      'get_node',
      'execute_node_console_command',
      'create_node',
      'rename_node',
      'delete_node',
      'manage_node_config',
      'manage_node_file',
      'get_proxy_rendered_config',
      'update_proxy_raw_config',
      'toggle_proxy_raw_mode',
      'list_users',
      'create_user',
      'update_user_role',
      'set_user_additional_permissions',
      'set_user_blocked',
      'delete_user',
      'get_ai_settings',
      'update_ai_settings',
      'list_ai_tools',
      'get_sandbox_runtime_status',
      'manage_ai_conversation',
      'manage_oauth_authorization',
      'manage_api_token',
      'get_license_status',
      'manage_license',
      'manage_housekeeping',
      'get_gateway_settings',
      'update_gateway_settings',
      'manage_system_updates',
      'get_audit_log',
      'get_dashboard_stats',
      'list_groups',
      'create_group',
      'update_group',
      'delete_group',
    ]);
    expect(TOOL_STORE_INVALIDATION_MAP.create_root_ca).toEqual(['ca']);
    expect(TOOL_STORE_INVALIDATION_MAP.manage_certificate).toEqual(['certificates', 'ca']);
    expect(TOOL_STORE_INVALIDATION_MAP.update_proxy_host).toEqual(['proxy']);
    expect(TOOL_STORE_INVALIDATION_MAP.manage_ssl_certificate).toEqual(['ssl']);
    expect(TOOL_STORE_INVALIDATION_MAP.create_user).toEqual(['users']);
    expect(TOOL_STORE_INVALIDATION_MAP.update_user_role).toEqual(['users']);
    expect(TOOL_STORE_INVALIDATION_MAP.set_user_additional_permissions).toEqual(['users']);
    expect(TOOL_STORE_INVALIDATION_MAP.set_user_blocked).toEqual(['users']);
    expect(TOOL_STORE_INVALIDATION_MAP.delete_user).toEqual(['users']);
    expect(TOOL_STORE_INVALIDATION_MAP.update_ai_settings).toEqual(['settings']);
    expect(TOOL_STORE_INVALIDATION_MAP.manage_license).toEqual(['settings']);
    expect(TOOL_STORE_INVALIDATION_MAP.manage_housekeeping).toEqual(['settings']);
    expect(toolNames(['feat:ai:use'])).toContain('set_resource_pin');
    expect(toolNames(['feat:ai:use'])).toEqual(expect.arrayContaining(['read_tool_output', 'search_tool_output']));
    expect(
      getOpenAITools([], ['feat:ai:use'], false, { discoveredToolsets: [] }).map((tool) => tool.function.name)
    ).toEqual(expect.arrayContaining(['read_tool_output', 'search_tool_output']));
    expect(
      getOpenAITools(['read_tool_output', 'search_tool_output'], ['feat:ai:use'], false).map(
        (tool) => tool.function.name
      )
    ).toEqual(expect.arrayContaining(['read_tool_output', 'search_tool_output']));
    expect(TOOL_STORE_INVALIDATION_MAP.update_gateway_settings).toEqual(['settings']);
    expect(isDestructiveTool('find_resource')).toBe(false);
    expect(isDestructiveTool('list_proxy_hosts')).toBe(false);
    expect(isDestructiveTool('get_proxy_host')).toBe(false);
    expect(isDestructiveTool('manage_ca')).toBe(true);
    expect(isDestructiveTool('create_proxy_folder')).toBe(true);
    expect(isDestructiveTool('execute_node_console_command')).toBe(true);
  });

  it('locks progress comments and the final answer to one language per run', () => {
    const sendComment = AI_TOOLS.find((tool) => tool.name === 'send_comment');

    expect(sendComment?.description).toContain('locks the response language');
    expect(sendComment?.parameters.properties).toMatchObject({
      message: expect.objectContaining({
        description: expect.stringContaining('language already used by this run'),
      }),
    });
  });

  it('exposes Cloudflare DNS-01 and SSL auto-renew controls to the agent', () => {
    const requestAcme = AI_TOOLS.find((tool) => tool.name === 'request_acme_cert');
    expect(requestAcme?.parameters.properties).toMatchObject({
      dnsProvider: { enum: ['cloudflare'] },
      autoRenew: expect.any(Object),
    });

    const manageSsl = AI_TOOLS.find((tool) => tool.name === 'manage_ssl_certificate');
    expect(manageSsl?.parameters.properties).toMatchObject({
      operation: { enum: expect.arrayContaining(['set_auto_renew']) },
      enabled: expect.any(Object),
      provider: { enum: ['cloudflare'] },
    });
  });

  it('requires approval metadata for every store-invalidating tool', () => {
    const invalidatingNonDestructiveTools = AI_TOOLS.filter(
      (tool) => tool.invalidateStores.length > 0 && !tool.destructive
    ).map((tool) => tool.name);

    expect(invalidatingNonDestructiveTools).toEqual([]);
  });

  it('keeps PKI, proxy, SSL, and administration scope filtering stable', () => {
    expect(toolNames(['pki:ca:view:root'])).toEqual(expect.arrayContaining(['list_cas', 'get_ca']));
    expect(toolNames(['pki:cert:view'])).toEqual(
      expect.arrayContaining(['list_certificates', 'get_certificate', 'manage_certificate'])
    );
    expect(toolNames(['pki:templates:view'])).toEqual(expect.arrayContaining(['list_templates', 'manage_template']));
    expect(toolNames(['proxy:view'])).toEqual(expect.arrayContaining(['list_proxy_hosts', 'get_proxy_host']));
    expect(toolNames(['proxy:folders:manage'])).toEqual(
      expect.arrayContaining(['create_proxy_folder', 'move_hosts_to_folder', 'delete_proxy_folder'])
    );
    expect(toolNames(['ssl:cert:view'])).toEqual(
      expect.arrayContaining(['list_ssl_certificates', 'manage_ssl_certificate'])
    );
    expect(toolNames(['admin:users'])).toEqual(
      expect.arrayContaining([
        'list_users',
        'create_user',
        'update_user_role',
        'set_user_additional_permissions',
        'set_user_blocked',
        'delete_user',
      ])
    );
    expect(toolNames(['admin:groups'])).toEqual(
      expect.arrayContaining(['list_groups', 'create_group', 'update_group', 'delete_group'])
    );
    expect(toolNames(['feat:ai:use'])).toEqual(
      expect.arrayContaining([
        'discover_tools',
        'get_current_context',
        'wait',
        'send_comment',
        'find_resource',
        'search_chats',
        'find_in_chat',
        'read_chat_slice',
        'list_chat_projects',
        'manage_ai_conversation',
        'manage_oauth_authorization',
        'get_dashboard_stats',
        'ask_question',
        'internal_documentation',
      ])
    );
    expect(toolNames(['proxy:raw:read:proxy-1'])).toContain('get_proxy_rendered_config');
    expect(toolNames(['proxy:raw:read:proxy-1'])).not.toContain('update_proxy_raw_config');
    expect(toolNames(['nodes:details'])).not.toContain('execute_node_console_command');
    expect(toolNames(['nodes:console'])).toContain('execute_node_console_command');
    expect(toolNames(['domains:view'])).toContain('list_domains');
    expect(toolNames(['domains:view'])).not.toContain('create_domain');
    expect(toolNames(['domains:create'])).toContain('create_domain');
    expect(toolNames(['integrations:cloudflare:dns:edit'])).not.toContain('create_domain');
    expect(toolNames(['domains:delete'])).toContain('delete_domain');
    expect(toolNames(['integrations:cloudflare:dns:delete'])).not.toContain('delete_domain');
    expect(toolNames(['domains:view'])).toContain('manage_domain');
    expect(toolNames(['integrations:cloudflare:dns:view'])).not.toContain('manage_domain');
  });

  it('requires direct database view before advertising database query tools', () => {
    expect(toolNames(['databases:query:read:db-1'])).not.toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-2'])).not.toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('query_postgres_read');
    expect(toolNames(['databases:view:db-1', 'databases:query:read:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:write:db-1'])).toContain('execute_postgres_sql');
    expect(toolNames(['databases:view:db-1', 'databases:query:admin:db-1'])).toContain('execute_postgres_sql');
  });

  it('keeps notification and web-search tool registry contracts stable', () => {
    const notificationToolNames = AI_TOOLS.filter((tool) => tool.category === 'Notifications').map((tool) => tool.name);

    expect(notificationToolNames).toEqual([
      'list_alert_rules',
      'get_alert_rule',
      'create_alert_rule',
      'update_alert_rule',
      'delete_alert_rule',
      'list_webhooks',
      'create_webhook',
      'update_webhook',
      'delete_webhook',
      'test_webhook',
      'list_webhook_deliveries',
      'get_delivery_stats',
      'list_siem_destinations',
      'get_siem_destination',
      'create_siem_destination',
      'update_siem_destination',
      'delete_siem_destination',
      'test_siem_destination',
      'list_siem_deliveries',
      'get_siem_delivery',
      'requeue_siem_delivery',
    ]);
    expect(notificationToolNamesForScopes(['notifications:view'])).toEqual([
      'list_alert_rules',
      'get_alert_rule',
      'list_webhooks',
      'list_webhook_deliveries',
      'get_delivery_stats',
    ]);
    expect(notificationToolNamesForScopes(['notifications:manage'])).toEqual([
      'list_alert_rules',
      'get_alert_rule',
      'create_alert_rule',
      'update_alert_rule',
      'delete_alert_rule',
      'list_webhooks',
      'create_webhook',
      'update_webhook',
      'delete_webhook',
      'test_webhook',
      'list_webhook_deliveries',
      'get_delivery_stats',
    ]);
    expect(notificationToolNamesForScopes(['audit:siem:view'])).toEqual([
      'list_siem_destinations',
      'get_siem_destination',
      'list_siem_deliveries',
      'get_siem_delivery',
    ]);
    expect(notificationToolNamesForScopes(['audit:siem:manage'])).toEqual([
      'list_siem_destinations',
      'get_siem_destination',
      'create_siem_destination',
      'update_siem_destination',
      'delete_siem_destination',
      'test_siem_destination',
      'list_siem_deliveries',
      'get_siem_delivery',
      'requeue_siem_delivery',
    ]);
    const createSiemDestination = AI_TOOLS.find((tool) => tool.name === 'create_siem_destination');
    expect(createSiemDestination?.parameters).toMatchObject({
      properties: { authType: { enum: expect.arrayContaining(['custom_header']) } },
    });
    expect(isDestructiveTool('create_alert_rule')).toBe(true);
    expect(isDestructiveTool('test_webhook')).toBe(false);

    expect(toolNames(['feat:ai:use'])).not.toContain('web_search');
    expect(getOpenAITools([], ['feat:ai:use'], true).map((tool) => tool.function.name)).toContain('web_search');
  });

  it('can narrow model-visible tools to base tools plus discovered categories', () => {
    const baseToolNames = getOpenAITools([], ['feat:ai:use', 'logs:schemas:view', 'docker:containers:view'], true, {
      discoveredToolsets: [],
    }).map((tool) => tool.function.name);

    expect(baseToolNames).toEqual(
      expect.arrayContaining([
        'discover_tools',
        'get_current_context',
        'wait',
        'send_comment',
        'find_resource',
        'ask_question',
        'internal_documentation',
        'web_search',
      ])
    );
    expect(baseToolNames).not.toContain('manage_logging');
    expect(baseToolNames).not.toContain('list_docker_containers');

    const loggingToolNames = getOpenAITools([], ['feat:ai:use', 'logs:schemas:view', 'docker:containers:view'], false, {
      discoveredToolsets: ['Logging'],
    }).map((tool) => tool.function.name);

    expect(loggingToolNames).toContain('manage_logging');
    expect(loggingToolNames).not.toContain('list_docker_containers');
    expect(loggingToolNames).not.toContain('web_search');
  });

  it('does not advertise ask_question as a duplicate approval mechanism', () => {
    const askQuestion = AI_TOOLS.find((tool) => tool.name === 'ask_question');

    expect(askQuestion?.description).toContain('Never use this tool to confirm or approve an action');
    expect(askQuestion?.description).toContain("Gateway's approval UI handles policy-required confirmations");
    expect(askQuestion?.description).toContain('choose automatically/use defaults');
  });

  it('advertises direct public Docker Hub pulls without a saved registry', () => {
    const pullImage = AI_TOOLS.find((tool) => tool.name === 'pull_docker_image');
    const createContainer = AI_TOOLS.find((tool) => tool.name === 'create_docker_container');
    const manageRegistry = AI_TOOLS.find((tool) => tool.name === 'manage_docker_registry');

    expect(createContainer?.description).toContain('use list_docker_images and pull_docker_image');
    expect(pullImage?.description).toContain('registryId omitted');
    expect(pullImage?.description).toContain('never create a saved Docker Hub registry');
    expect(manageRegistry?.description).toContain('Do not create a registry for public Docker Hub images');
  });

  it('advertises only managed volume mounts and supported runtime profiles for container creation', () => {
    const createContainer = AI_TOOLS.find((tool) => tool.name === 'create_docker_container');
    const properties = createContainer?.parameters.properties as Record<string, any>;
    const volumeProperties = properties.volumes.items.properties as Record<string, unknown>;

    expect(volumeProperties).not.toHaveProperty('hostPath');
    expect(properties.volumes.items.required).toEqual(['containerPath', 'name']);
    expect(properties.runtimeProfile.enum).toEqual(['default', 'secure']);
    expect(createContainer?.description).toContain('never provide host bind paths');
  });

  it('exposes fetch as a base tool for direct URLs when sandbox access is enabled', () => {
    const baseToolNames = getOpenAITools([], ['feat:ai:use', 'ai:sandbox:use'], false, {
      discoveredToolsets: [],
      sandboxEnabled: true,
    }).map((tool) => tool.function.name);

    expect(baseToolNames).toContain('fetch');
    expect(baseToolNames).not.toContain('execute_script');
    expect(baseToolNames).not.toContain('download_artifact');
  });

  it('infers hidden toolsets from explicit Gateway tool names in user text', () => {
    const inferred = inferDiscoveredToolsetsFromText(
      'Start a process, run download_artifact, then send artifact back to me.'
    );

    expect(inferred).toEqual(['Sandbox']);

    const toolNames = getOpenAITools([], ['feat:ai:use', 'ai:sandbox:use'], false, {
      discoveredToolsets: inferred,
      sandboxEnabled: true,
    }).map((tool) => tool.function.name);

    expect(toolNames).toContain('run_process');
    expect(toolNames).toContain('download_artifact');
    expect(toolNames).toContain('send_artifact');
  });

  it('keeps logging and status-page tool registry contracts stable', () => {
    const manageLogging = AI_TOOLS.find((tool) => tool.name === 'manage_logging');
    expect(AI_TOOLS.filter((tool) => tool.category === 'Logging').map((tool) => tool.name)).toEqual(['manage_logging']);
    expect(AI_TOOLS.filter((tool) => tool.category === 'Status Page').map((tool) => tool.name)).toEqual([
      'manage_status_page',
    ]);

    expect(manageLogging?.description).toContain('resource: "schema"');
    expect(manageLogging?.description).toContain('operation: "create"');
    expect(toolNames(['logs:environments:view'])).toContain('manage_logging');
    expect(toolNames(['logs:environments:view'])).toContain('find_resource');
    expect(toolNames(['logs:schemas:view'])).toContain('find_resource');
    expect(toolNames(['status-page:view'])).toContain('manage_status_page');
    expect(toolNames(['logs:read'])).toContain('manage_logging');
    expect(isDestructiveTool('manage_logging')).toBe(true);
    expect(isDestructiveTool('manage_status_page')).toBe(true);
  });

  it('keeps AI assistant configuration tools scoped to assistant configuration admins', () => {
    const aiToolNames = AI_TOOLS.filter((tool) => tool.category === 'AI Workspace').map((tool) => tool.name);

    expect(aiToolNames).toEqual([
      'get_ai_settings',
      'update_ai_settings',
      'list_ai_tools',
      'get_sandbox_runtime_status',
    ]);
    expect(toolNames(['feat:ai:configure'])).toEqual(expect.arrayContaining(aiToolNames));
    expect(toolNames(['feat:ai:use'])).not.toEqual(expect.arrayContaining(aiToolNames));
    expect(isDestructiveTool('get_ai_settings')).toBe(false);
    expect(isDestructiveTool('list_ai_tools')).toBe(false);
    expect(isDestructiveTool('get_sandbox_runtime_status')).toBe(false);
    expect(isDestructiveTool('update_ai_settings')).toBe(true);
  });

  it('keeps user-owned conversation and OAuth tools scoped to assistant users', () => {
    expect(AI_TOOLS.filter((tool) => tool.category === 'Conversations').map((tool) => tool.name)).toEqual([
      'manage_ai_conversation',
    ]);
    expect(AI_TOOLS.filter((tool) => tool.category === 'OAuth').map((tool) => tool.name)).toEqual([
      'manage_oauth_authorization',
    ]);
    expect(toolNames(['feat:ai:use'])).toEqual(
      expect.arrayContaining(['manage_ai_conversation', 'manage_oauth_authorization', 'manage_api_token'])
    );
    expect(isDestructiveTool('manage_ai_conversation')).toBe(true);
    expect(isDestructiveTool('manage_oauth_authorization')).toBe(true);
    expect(isDestructiveTool('manage_api_token')).toBe(true);
  });

  it('keeps maintenance tools scoped to license and housekeeping permissions', () => {
    const maintenanceToolNames = AI_TOOLS.filter((tool) => tool.category === 'Maintenance').map((tool) => tool.name);

    expect(maintenanceToolNames).toEqual([
      'get_license_status',
      'manage_license',
      'manage_housekeeping',
      'get_gateway_settings',
      'update_gateway_settings',
      'manage_system_updates',
    ]);
    expect(toolNames(['license:view'])).toContain('get_license_status');
    expect(toolNames(['license:view'])).not.toContain('manage_license');
    expect(toolNames(['license:manage'])).toEqual(expect.arrayContaining(['get_license_status', 'manage_license']));
    expect(toolNames(['housekeeping:view'])).toContain('manage_housekeeping');
    expect(toolNames(['settings:gateway:view'])).toContain('get_gateway_settings');
    expect(toolNames(['settings:gateway:view'])).not.toContain('update_gateway_settings');
    expect(toolNames(['settings:gateway:edit'])).toEqual(
      expect.arrayContaining(['get_gateway_settings', 'update_gateway_settings'])
    );
    expect(toolNames(['admin:update'])).toContain('manage_system_updates');
    expect(toolNames(['feat:ai:use'])).not.toEqual(expect.arrayContaining(maintenanceToolNames));
    expect(isDestructiveTool('get_license_status')).toBe(false);
    expect(isDestructiveTool('get_gateway_settings')).toBe(false);
    expect(isDestructiveTool('manage_license')).toBe(true);
    expect(isDestructiveTool('manage_housekeeping')).toBe(true);
    expect(isDestructiveTool('update_gateway_settings')).toBe(true);
    expect(isDestructiveTool('manage_system_updates')).toBe(true);
  });

  it('keeps database tool registry contracts stable', () => {
    const databaseToolNames = AI_TOOLS.filter((tool) => tool.category === 'Databases').map((tool) => tool.name);

    expect(databaseToolNames).toEqual([
      'list_databases',
      'get_database_connection',
      'query_postgres_read',
      'execute_postgres_sql',
      'browse_redis_keys',
      'get_redis_key',
      'set_redis_key',
      'execute_redis_command',
      'manage_database_connection',
      'manage_postgres_data',
      'manage_redis_data',
    ]);
    expect(databaseToolNamesForScopes(['databases:view'])).toEqual([
      'list_databases',
      'get_database_connection',
      'manage_database_connection',
    ]);
    expect(databaseToolNamesForScopes(['databases:view', 'databases:query:read'])).toEqual([
      'list_databases',
      'get_database_connection',
      'query_postgres_read',
      'execute_postgres_sql',
      'browse_redis_keys',
      'get_redis_key',
      'manage_database_connection',
      'manage_postgres_data',
      'manage_redis_data',
    ]);
    expect(isDestructiveTool('query_postgres_read')).toBe(false);
    expect(isDestructiveTool('execute_postgres_sql')).toBe(true);
    expect(isDestructiveTool('manage_database_connection')).toBe(true);
  });

  it('keeps docker tool registry contracts stable', () => {
    const dockerToolNames = AI_TOOLS.filter((tool) => tool.category === 'Docker').map((tool) => tool.name);

    expect(dockerToolNames).toEqual([
      'create_docker_container',
      'list_docker_containers',
      'get_docker_container',
      'execute_docker_container_console_command',
      'list_docker_deployments',
      'get_docker_deployment',
      'start_docker_deployment',
      'stop_docker_deployment',
      'restart_docker_deployment',
      'kill_docker_deployment',
      'deploy_docker_deployment',
      'switch_docker_deployment_slot',
      'rollback_docker_deployment',
      'stop_docker_deployment_slot',
      'start_docker_container',
      'stop_docker_container',
      'restart_docker_container',
      'remove_docker_container',
      'update_docker_container_image',
      'rename_docker_container',
      'duplicate_docker_container',
      'get_docker_container_stats',
      'get_docker_container_logs',
      'list_docker_images',
      'pull_docker_image',
      'remove_docker_image',
      'prune_docker_images',
      'list_docker_volumes',
      'list_docker_networks',
      'manage_docker_registry',
      'manage_docker_volume',
      'manage_docker_network',
      'manage_docker_task',
      'manage_docker_container_config',
    ]);
    expect(dockerToolNamesForScopes(['docker:containers:view'])).toEqual([
      'list_docker_containers',
      'get_docker_container',
      'list_docker_deployments',
      'get_docker_deployment',
      'get_docker_container_stats',
      'get_docker_container_logs',
      'manage_docker_container_config',
    ]);
    expect(dockerToolNamesForScopes(['docker:containers:manage'])).toEqual([
      'list_docker_containers',
      'get_docker_container',
      'list_docker_deployments',
      'get_docker_deployment',
      'start_docker_deployment',
      'stop_docker_deployment',
      'restart_docker_deployment',
      'kill_docker_deployment',
      'deploy_docker_deployment',
      'switch_docker_deployment_slot',
      'rollback_docker_deployment',
      'stop_docker_deployment_slot',
      'start_docker_container',
      'stop_docker_container',
      'restart_docker_container',
      'update_docker_container_image',
      'get_docker_container_stats',
      'get_docker_container_logs',
      'manage_docker_container_config',
    ]);
    expect(dockerToolNamesForScopes(['docker:images:view'])).toEqual(['list_docker_images']);
    expect(dockerToolNamesForScopes(['docker:volumes:view'])).toEqual(['list_docker_volumes']);
    expect(dockerToolNamesForScopes(['docker:networks:view'])).toEqual(['list_docker_networks']);
    expect(dockerToolNamesForScopes(['docker:containers:console:node-1'])).toContain(
      'execute_docker_container_console_command'
    );
    expect(AI_TOOLS.find((tool) => tool.name === 'create_docker_container')?.invalidateStores).toEqual(['containers']);
    expect(AI_TOOLS.find((tool) => tool.name === 'deploy_docker_deployment')?.invalidateStores).toEqual([
      'containers',
      'tasks',
    ]);
    expect(isDestructiveTool('list_docker_containers')).toBe(false);
    expect(isDestructiveTool('create_docker_container')).toBe(true);
    expect(isDestructiveTool('execute_docker_container_console_command')).toBe(true);
    expect(isDestructiveTool('manage_docker_task')).toBe(false);
  });

  it('only advertises sandbox tools when sandbox is enabled and scoped', () => {
    const expectedSandboxTools = [
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
    ];

    expect(AI_TOOLS.filter((tool) => tool.category === 'Sandbox').map((tool) => tool.name)).toEqual(
      expectedSandboxTools
    );
    expect(sandboxToolNamesForScopes(['ai:sandbox:use'], false)).toEqual([]);
    expect(sandboxToolNamesForScopes([], true)).toEqual([]);
    expect(sandboxToolNamesForScopes(['ai:sandbox:use'], true)).toEqual(expectedSandboxTools);
    expect(AI_TOOLS.find((tool) => tool.name === 'run_process')?.description).toContain(
      'The process working directory is /workspace'
    );
    expect(AI_TOOLS.find((tool) => tool.name === 'send_artifact')?.description).toContain(
      'path argument must be relative to /workspace'
    );
    expect(AI_TOOLS.find((tool) => tool.name === 'list_artifact_files')?.description).toContain(
      'without starting another sandbox process'
    );
    expect(isDestructiveTool('execute_script')).toBe(true);
    expect(isDestructiveTool('run_process')).toBe(true);
    expect(isDestructiveTool('fetch')).toBe(false);
    expect(isDestructiveTool('download_artifact')).toBe(false);
    expect(isDestructiveTool('list_artifact_files')).toBe(false);
    expect(isDestructiveTool('read_artifact')).toBe(false);
    expect(isDestructiveTool('send_artifact')).toBe(false);
    expect(isDestructiveTool('read_process_output')).toBe(false);
    expect(isDestructiveTool('list_sandbox_jobs')).toBe(false);
  });
});
