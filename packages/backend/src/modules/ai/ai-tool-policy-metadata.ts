import type { AIToolApprovalClass, AIToolDefinition, AIToolEffect, AIToolOperationPolicy } from './ai.types.js';

type OperationGroups = Partial<Record<AIToolApprovalClass | 'external', readonly string[]>>;

function operationPolicies(groups: OperationGroups): Record<string, AIToolOperationPolicy> {
  const result: Record<string, AIToolOperationPolicy> = {};
  for (const [group, operations] of Object.entries(groups)) {
    const effect: AIToolEffect =
      group === 'read' ? 'read' : group === 'delete' ? 'delete' : group === 'external' ? 'external' : 'write';
    const approvalClass: AIToolApprovalClass = group === 'external' ? 'destructive' : (group as AIToolApprovalClass);
    for (const operation of operations ?? []) result[operation] = { effect, approvalClass };
  }
  return result;
}

const OPERATION_POLICIES: Record<string, Record<string, AIToolOperationPolicy>> = {
  manage_ca: operationPolicies({ update: ['update'] }),
  manage_certificate: operationPolicies({ read: ['export', 'chain'], create: ['issue_from_csr'] }),
  manage_template: operationPolicies({ read: ['get'], update: ['update'] }),
  manage_resource_folder: operationPolicies({
    create: ['create'],
    update: ['update', 'move_folder', 'reorder_folders', 'move_resources', 'reorder_resources'],
    delete: ['delete'],
  }),
  manage_proxy_template: operationPolicies({
    read: ['list', 'get'],
    create: ['create', 'clone'],
    update: ['update'],
    delete: ['delete'],
  }),
  manage_ssl_certificate: operationPolicies({
    read: ['get'],
    update: ['upload', 'set_auto_renew'],
    external: ['renew', 'verify_dns'],
    delete: ['delete'],
  }),
  manage_domain: operationPolicies({ read: ['get'], update: ['update'], external: ['check_dns'] }),
  manage_access_list: operationPolicies({ read: ['get'], update: ['update'] }),
  manage_node_config: operationPolicies({ read: ['read'], update: ['update'], external: ['test'] }),
  manage_node_file: operationPolicies({
    read: ['list', 'read'],
    create: ['create', 'mkdir', 'upload_init'],
    update: ['write', 'move', 'upload_chunk', 'upload_complete'],
    delete: ['delete', 'upload_abort'],
  }),
  manage_ai_conversation: operationPolicies({ read: ['list', 'get'], delete: ['delete', 'delete_by_title'] }),
  manage_oauth_authorization: operationPolicies({ read: ['list'], update: ['update_scopes'], delete: ['revoke'] }),
  manage_api_token: operationPolicies({ read: ['list'], create: ['create'], update: ['update'], delete: ['revoke'] }),
  manage_license: operationPolicies({ external: ['activate', 'check'], delete: ['clear'] }),
  manage_housekeeping: operationPolicies({
    read: ['get_config', 'get_stats', 'get_history'],
    update: ['update_config'],
    execute: ['run'],
  }),
  manage_system_updates: operationPolicies({
    read: ['get_gateway_status', 'list_daemon_updates'],
    external: ['check_gateway', 'get_gateway_release_notes', 'check_daemon_updates'],
    execute: ['perform_gateway_update', 'update_daemon'],
  }),
  manage_docker_registry: operationPolicies({
    read: ['list', 'get'],
    create: ['create'],
    update: ['update'],
    delete: ['delete'],
    external: ['test', 'test_direct'],
  }),
  manage_docker_volume: operationPolicies({ create: ['create'], delete: ['delete'] }),
  manage_docker_network: operationPolicies({
    create: ['create'],
    delete: ['delete', 'disconnect'],
    external: ['connect'],
  }),
  manage_docker_task: operationPolicies({ read: ['list', 'get'] }),
  manage_docker_container_config: operationPolicies({
    read: ['get_env', 'list_files', 'read_file', 'list_secrets', 'get_webhook', 'get_health_check'],
    create: ['create_secret'],
    update: [
      'update_env',
      'write_file',
      'update_secret',
      'upsert_webhook',
      'regenerate_webhook_token',
      'upsert_health_check',
    ],
    delete: ['delete_secret', 'delete_webhook'],
    external: ['test_health_check'],
  }),
  manage_database_connection: operationPolicies({
    read: ['reveal_credentials', 'health_history'],
    create: ['create'],
    update: ['update'],
    delete: ['delete'],
    external: ['test'],
  }),
  manage_postgres_data: operationPolicies({
    read: ['list_schemas', 'list_tables', 'table_metadata', 'browse_rows'],
    create: ['insert_row', 'add_column'],
    update: ['update_row', 'update_column_type'],
    delete: ['delete_row', 'delete_column'],
  }),
  manage_redis_data: operationPolicies({
    read: ['scan_keys', 'get_key'],
    update: ['set_key', 'expire_key'],
    delete: ['delete_key'],
    execute: ['execute_command'],
  }),
  manage_managed_database: operationPolicies({
    read: ['catalog', 'list', 'get', 'list_bindings'],
    create: ['create', 'create_binding'],
    update: ['update', 'retry', 'rotate_certificate'],
    execute: ['restart', 'pause', 'unpause'],
    delete: ['delete', 'delete_binding'],
  }),
  manage_pages: operationPolicies({
    read: [
      'profile_get',
      'profile_options',
      'project_list',
      'project_get',
      'deployment_list',
      'deployment_get',
      'tag_list',
      'token_list',
      'config_list',
    ],
    create: ['project_create', 'token_create'],
    update: [
      'profile_configure',
      'profile_disable',
      'project_update',
      'deployment_pin',
      'tag_move',
      'config_save_default',
      'config_save_tag',
      'config_reset_tag',
    ],
    execute: ['project_migrate'],
    delete: ['project_delete', 'deployment_delete', 'tag_delete', 'token_revoke'],
  }),
  manage_additional_route: operationPolicies({
    read: ['list', 'get'],
    create: ['create'],
    update: ['update', 'retry'],
    delete: ['delete'],
  }),
  manage_additional_secure_link: operationPolicies({
    read: ['list'],
    create: ['create'],
    update: ['retry'],
    delete: ['delete'],
  }),
  manage_docker_migration: operationPolicies({
    read: ['preflight', 'get'],
    execute: ['start', 'cancel', 'retry_cleanup'],
  }),
  manage_logging_backend: operationPolicies({
    read: ['get'],
    external: ['enable_local', 'configure_external', 'disable'],
  }),
  manage_inference_provider: operationPolicies({
    read: ['list_templates', 'list_connections', 'authorization_status'],
    update: ['sync', 'update', 'set_routing'],
    delete: ['cancel_authorization', 'disconnect'],
    external: ['connect_api_key', 'start_authorization'],
  }),
  manage_inference_model: operationPolicies({ read: ['list', 'suggestions'], update: ['save'], delete: ['delete'] }),
  manage_inference_limits: operationPolicies({
    read: ['list_policies', 'list_users'],
    update: ['set_default', 'set_user'],
    delete: ['remove_user'],
  }),
  manage_inference_token: operationPolicies({ read: ['list'], create: ['create'], delete: ['revoke'] }),
};

const COMPOSITE_OPERATION_POLICIES: Record<
  string,
  { arguments: string[]; operations: Record<string, AIToolOperationPolicy> }
> = {
  manage_logging: {
    arguments: ['resource', 'operation'],
    operations: operationPolicies({
      read: [
        'environment.list',
        'environment.get',
        'schema.list',
        'schema.get',
        'token.list',
        'logs.search',
        'facets.facets',
        'metadata.metadata',
      ],
      create: ['environment.create', 'schema.create', 'token.create'],
      update: ['environment.update', 'schema.update'],
      delete: ['environment.delete', 'schema.delete', 'token.delete'],
    }),
  },
  manage_status_page: {
    arguments: ['resource', 'operation'],
    operations: operationPolicies({
      read: ['settings.get', 'proxy_templates.list', 'services.list', 'incidents.list', 'preview.preview'],
      create: ['services.create', 'incidents.create', 'incident_updates.create_update'],
      update: ['settings.update', 'services.update', 'incidents.update', 'incidents.resolve', 'incidents.promote'],
      delete: ['services.delete', 'incidents.delete'],
    }),
  },
};

const TOOL_POLICIES: Record<string, Pick<AIToolDefinition, 'effect' | 'approvalClass'>> = {
  test_webhook: { effect: 'external', approvalClass: 'destructive' },
  test_siem_destination: { effect: 'external', approvalClass: 'destructive' },
  request_acme_cert: { effect: 'external', approvalClass: 'destructive' },
  create_domain: { effect: 'external', approvalClass: 'destructive' },
  delete_domain: { effect: 'external', approvalClass: 'delete' },
  pull_docker_image: { effect: 'external', approvalClass: 'destructive' },
  download_artifact: { effect: 'external', approvalClass: 'destructive' },
  send_artifact: { effect: 'external', approvalClass: 'destructive' },
};

const PLANNING_SAFE_TOOL_NAMES = new Set([
  'ask_question',
  'audit_system_pki_leaves',
  'browse_redis_keys',
  'discover_tools',
  'read_skill',
  'activate_skill',
  'enter_plan_mode',
  'fetch',
  'find_in_chat',
  'find_resource',
  'finalize_plan_execution',
  'get_ai_settings',
  'get_alert_rule',
  'get_audit_log',
  'get_ca',
  'get_certificate',
  'get_current_context',
  'get_dashboard_stats',
  'get_database_connection',
  'get_delivery_stats',
  'get_docker_container',
  'get_docker_container_logs',
  'get_docker_container_stats',
  'get_docker_deployment',
  'get_gateway_settings',
  'get_license_status',
  'get_node',
  'get_route',
  'get_route_rendered_config',
  'get_redis_key',
  'get_sandbox_runtime_status',
  'get_siem_delivery',
  'get_siem_destination',
  'git_list_connectors',
  'git_list_remote_refs',
  'git_list_repository_tree',
  'git_read_repository_file',
  'gitlab_get_job_log',
  'gitlab_get_pipeline',
  'gitlab_get_pipeline_jobs',
  'gitlab_get_project',
  'gitlab_lint_ci_config',
  'gitlab_list_connectors',
  'gitlab_list_pipelines',
  'gitlab_list_project_variables',
  'gitlab_list_project_webhooks',
  'gitlab_list_projects',
  'gitlab_list_registry_repositories',
  'gitlab_list_repository_tree',
  'gitlab_read_file',
  'gitlab_search_projects',
  'github_list_actions_secrets',
  'github_list_actions_variables',
  'github_list_branches',
  'github_list_connectors',
  'github_list_repositories',
  'github_list_repository_tree',
  'github_list_workflow_runs',
  'github_read_repository_file',
  'internal_documentation',
  'list_access_lists',
  'list_ai_tools',
  'list_alert_rules',
  'list_artifact_files',
  'list_cas',
  'list_certificates',
  'list_chat_projects',
  'list_databases',
  'list_docker_containers',
  'list_docker_deployments',
  'list_docker_images',
  'list_docker_networks',
  'list_docker_volumes',
  'list_domains',
  'list_groups',
  'list_nodes',
  'list_routes',
  'list_resource_folders',
  'list_sandbox_jobs',
  'list_siem_deliveries',
  'list_siem_destinations',
  'list_ssl_certificates',
  'list_templates',
  'list_users',
  'list_webhook_deliveries',
  'list_webhooks',
  'pause_plan_execution',
  'open_connector_setup',
  'query_postgres_read',
  'read_artifact',
  'read_chat_slice',
  'read_process_output',
  'read_tool_output',
  'resume_plan_execution',
  'search_chats',
  'search_compacted_history',
  'search_tool_output',
  'send_comment',
  'ssh_list_connectors',
  'submit_plan',
  'submit_plan_review',
  'start_plan_execution',
  'submit_plan_verification',
  'update_plan_step',
  'wait',
  'web_search',
]);

export function withAIToolPolicyMetadata(tools: readonly AIToolDefinition[]): AIToolDefinition[] {
  return tools.map((tool) => {
    const operations = OPERATION_POLICIES[tool.name];
    const composite = COMPOSITE_OPERATION_POLICIES[tool.name];
    const standalone = TOOL_POLICIES[tool.name];
    const targetIdentity = inferToolTargetIdentity(tool);
    return {
      ...tool,
      ...standalone,
      planningAccess:
        PLANNING_SAFE_TOOL_NAMES.has(tool.name) ||
        Object.values(operations ?? {}).some((policy) => policy.effect === 'read') ||
        Object.values(composite?.operations ?? {}).some((policy) => policy.effect === 'read')
          ? 'allowed'
          : 'blocked',
      ...(targetIdentity ? { targetIdentity } : {}),
      ...(operations ? { operationDiscriminator: { arguments: ['operation'], operations } } : {}),
      ...(composite ? { operationDiscriminator: composite } : {}),
    };
  });
}

export function getAIToolResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | undefined,
  args: Record<string, unknown>
): string {
  const argumentsList = tool?.targetIdentity?.arguments ?? [
    'caId',
    'parentCaId',
    'certificateId',
    'routeId',
    'proxyHostId',
    'domainId',
    'accessListId',
    'templateId',
    'userId',
    'containerId',
    'deploymentId',
    'databaseId',
    'ruleId',
    'webhookId',
    'registryId',
    'nodeId',
  ];
  for (const argument of argumentsList) {
    const value = args[argument];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function inferToolTargetIdentity(tool: AIToolDefinition): AIToolDefinition['targetIdentity'] {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const available = new Set(Object.keys(properties));
  const preferred = tool.requiredScope.startsWith('docker:containers:')
    ? ['containerId', 'deploymentId', 'containerName', 'nodeId']
    : tool.requiredScope.startsWith('docker:registries:')
      ? ['registryId', 'nodeId']
      : tool.requiredScope.startsWith('docker:deployments:')
        ? ['deploymentId', 'containerId', 'containerName', 'nodeId']
        : tool.requiredScope.startsWith('databases:')
          ? ['databaseId', 'nodeId']
          : tool.requiredScope.startsWith('pages:')
            ? ['projectId', 'deploymentId', 'tagId', 'nodeId']
            : [
                'caId',
                'parentCaId',
                'certificateId',
                'routeId',
                'proxyHostId',
                'domainId',
                'accessListId',
                'templateId',
                'userId',
                'containerId',
                'deploymentId',
                'databaseId',
                'ruleId',
                'webhookId',
                'nodeId',
                'registryId',
              ];
  const argumentsList = preferred.filter((argument) => available.has(argument));
  return argumentsList.length > 0 ? { arguments: argumentsList } : undefined;
}

export function getDeclaredOperationPolicyToolNames(): string[] {
  return [...Object.keys(OPERATION_POLICIES), ...Object.keys(COMPOSITE_OPERATION_POLICIES)].sort();
}
