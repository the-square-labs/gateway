import { describe, expect, it } from 'vitest';
import { DOC_TOPIC_SCOPES, getInternalDocumentation, INTERNAL_DOCS } from './ai.docs.js';
import { AI_TOOLS } from './ai.tools.js';

describe('AI internal docs registry', () => {
  it('keeps topic registry and scope contracts stable', () => {
    expect(Object.keys(INTERNAL_DOCS)).toEqual([
      'discovery',
      'pki',
      'ssl',
      'proxy',
      'domains',
      'access-lists',
      'templates',
      'acme',
      'users',
      'audit',
      'siem',
      'nginx',
      'nodes',
      'housekeeping',
      'permissions',
      'docker',
      'databases',
      'pages',
      'postgres',
      'redis',
      'logging',
      'folders',
      'node-files',
      'sandbox',
      'conversations',
      'status-page',
      'api',
      'gateway-settings',
      'licensing-updates',
      'inference',
      'ai-settings',
      'gitlab',
      'notifications',
      'overview',
      'installation',
      'authentication',
      'cloudflare',
      'docker-registries',
      'clickhouse',
      'troubleshooting',
    ]);
    expect(DOC_TOPIC_SCOPES).toMatchObject({
      discovery: 'feat:ai:use',
      permissions: 'feat:ai:use',
      docker: 'docker:containers:view',
      logging: ['logs:environments:view', 'logs:schemas:view', 'logs:read', 'logs:manage'],
      folders: expect.arrayContaining(['nodes:folders:manage', 'domains:folders:manage']),
      'node-files': ['nodes:files:read', 'nodes:files:write'],
      sandbox: 'ai:sandbox:use',
      conversations: 'feat:ai:use',
      'ai-settings': 'feat:ai:configure',
      'status-page': 'status-page:view',
      'gateway-settings': ['settings:gateway:view', 'settings:gateway:edit'],
      'licensing-updates': ['license:view', 'license:manage', 'admin:update'],
      gitlab: 'integrations:gitlab:view',
      notifications: ['notifications:view', 'audit:siem:view'],
      siem: 'audit:siem:view',
      overview: 'feat:ai:use',
      installation: 'feat:ai:use',
      authentication: 'feat:ai:use',
      cloudflare: 'integrations:cloudflare:view',
      'docker-registries': 'docker:registries:view',
      clickhouse: 'databases:view',
      troubleshooting: 'feat:ai:use',
      proxy: 'proxy:view',
      pages: 'pages:view',
      inference: expect.arrayContaining(['feat:ai:use', 'inference:providers:manage', 'inference:models:manage']),
    });
  });

  it('keeps internal_documentation tool topics aligned with the docs registry', () => {
    const tool = AI_TOOLS.find((candidate) => candidate.name === 'internal_documentation');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('logging');
    expect(tool?.description).toContain('discovery');
    const parameters = tool?.parameters as { properties: { topic: { enum: string[] } } };
    expect(parameters.properties.topic.enum).toEqual(Object.keys(INTERNAL_DOCS));
  });

  it('returns allowed documentation and preserves permission topic content', () => {
    expect(getInternalDocumentation('permissions', ['feat:ai:use'])).toEqual({
      topic: 'permissions',
      content: INTERNAL_DOCS.permissions,
    });
    expect(INTERNAL_DOCS.permissions).toContain('# Permissions');
    expect(INTERNAL_DOCS.permissions).toContain('Resource-Scoped Permissions');
    expect(INTERNAL_DOCS.permissions).toContain('docker:containers:view');

    expect(getInternalDocumentation('discovery', ['feat:ai:use']).content).toContain('discover_tools');
    expect(getInternalDocumentation('discovery', ['feat:ai:use']).content).toContain('get_current_context');
    expect(getInternalDocumentation('discovery', ['feat:ai:use']).content).toContain('find_resource');
    expect(getInternalDocumentation('logging', ['logs:schemas:view']).content).toContain('manage_logging');
    expect(getInternalDocumentation('logging', ['logs:read:env-1']).content).toContain('External Logging');
    expect(getInternalDocumentation('folders', ['nodes:folders:manage']).content).toContain('list_resource_folders');
    expect(getInternalDocumentation('nodes', ['nodes:details']).content).toContain('manage_node_config');
    expect(getInternalDocumentation('nodes', ['nodes:details']).content).toContain('publicIpAddresses');
    expect(getInternalDocumentation('nodes', ['nodes:details']).content).toContain('serviceAddress');
    expect(getInternalDocumentation('proxy', ['proxy:view']).content).toContain('Maintenance Mode');
    expect(getInternalDocumentation('proxy', ['proxy:view']).content).toContain('Docker Upstreams');
    expect(getInternalDocumentation('proxy', ['proxy:view']).content).toContain('manage_additional_route');
    expect(getInternalDocumentation('pages', ['pages:view']).content).toContain('manage_pages');
    expect(getInternalDocumentation('users', ['admin:users']).content).toContain('additional per-user scopes');
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain('Cross-Node Migrations');
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain('last synchronized state');
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain('Isolation Profiles');
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'Secure workloads cannot attach GPUs or devices, use host bind mounts, migrate between nodes, or export'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'New or changed mounts can reference only Gateway-managed local volumes'
    );
    expect(getInternalDocumentation('nodes', ['nodes:details']).content).toContain('manual Setup in Node Details');
    expect(getInternalDocumentation('databases', ['databases:view']).content).toContain('Managed Instance Access');
    expect(getInternalDocumentation('databases', ['databases:view']).content).toContain(
      'private connector and authenticated Gateway tunnel'
    );
    expect(getInternalDocumentation('databases', ['databases:view']).content).toContain('manage_managed_database');
    expect(getInternalDocumentation('databases', ['databases:view']).content).toContain(
      'never reveal owner or binding credentials'
    );
    expect(getInternalDocumentation('node-files', ['nodes:files:read']).content).toContain('manage_node_file');
    expect(getInternalDocumentation('sandbox', ['ai:sandbox:use']).content).toContain('download_artifact');
    expect(getInternalDocumentation('sandbox', ['ai:sandbox:use']).content).toContain('list_artifact_files');
    expect(getInternalDocumentation('sandbox', ['ai:sandbox:use']).content).toContain(
      'Artifact tool path arguments are relative to /workspace'
    );
    expect(getInternalDocumentation('sandbox', ['ai:sandbox:use']).content).toContain(
      'run_process returns as soon as the process starts'
    );
    expect(getInternalDocumentation('conversations', ['feat:ai:use']).content).toContain('manage_ai_conversation');
    expect(getInternalDocumentation('conversations', ['feat:ai:use']).content).toContain(
      'reasoning effort are pinned to the conversation'
    );
    expect(getInternalDocumentation('conversations', ['feat:ai:use']).content).toContain(
      'up to three supported images'
    );
    expect(getInternalDocumentation('api', ['feat:ai:use']).content).toContain('manage_oauth_authorization');
    expect(getInternalDocumentation('api', ['feat:ai:use']).content).toContain('manage_api_token');
    expect(getInternalDocumentation('overview', ['feat:ai:use']).content).toContain(
      'self-hosted infrastructure control plane'
    );
    expect(getInternalDocumentation('overview', ['feat:ai:use']).content).toContain('set_resource_pin');
    expect(getInternalDocumentation('overview', ['feat:ai:use']).content).toContain(
      'Yellow means at least one warning card is visible'
    );
    expect(getInternalDocumentation('installation', ['feat:ai:use']).content).toContain('Browser Setup Wizard');
    expect(getInternalDocumentation('authentication', ['feat:ai:use']).content).toContain('email one-time-code');
    expect(getInternalDocumentation('cloudflare', ['integrations:cloudflare:view']).content).toContain(
      'encrypted API token'
    );
    expect(getInternalDocumentation('docker-registries', ['docker:registries:view']).content).toContain(
      'trusted HTTPS token-service origin'
    );
    expect(getInternalDocumentation('docker-registries', ['docker:registries:view']).content).toContain(
      'Public Docker Hub images such as `nginx:alpine` do not require a saved registry'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'do not use a failed create as an image-existence probe'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'target-node registry downloads'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'before stopping the existing container'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'manage_docker_volume` creates only a regular Gateway-managed local volume'
    );
    expect(getInternalDocumentation('docker', ['docker:containers:view']).content).toContain(
      'docker:containers:files:write'
    );
    expect(getInternalDocumentation('clickhouse', ['databases:view']).content).toContain('native TLS endpoint');
    expect(getInternalDocumentation('troubleshooting', ['feat:ai:use']).content).toContain('Start With Evidence');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).toContain('update_ai_settings');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).toContain('providerUrl');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).not.toContain('baseUrl:');
    expect(getInternalDocumentation('gateway-settings', ['settings:gateway:view']).content).toContain(
      'notifications/tools/list_changed'
    );
    expect(getInternalDocumentation('gateway-settings', ['settings:gateway:view']).content).toContain(
      'mcpExtendedCompatibility'
    );
    expect(getInternalDocumentation('licensing-updates', ['license:view']).content).toContain('get_license_status');
    expect(getInternalDocumentation('licensing-updates', ['admin:update']).content).toContain('manage_system_updates');
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'npx -y @wiolett/gateway-inference@latest setup codex'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'npx -y @wiolett/gateway-inference@latest setup claude-code'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'generalSettings.features.inferenceEnabled'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain('Claude Code 2.1.129 or newer');
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'Claude Desktop and the Claude Code VS Code extension'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain('/api/inference/v1');
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain('/api/inference/v1/messages');
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'Profile > Authorizations > Inference API tokens'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'models whose usable sources are API-only are omitted'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'reasoningEfforts array order is preserved'
    );
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain('API accounting ignores it');
    expect(getInternalDocumentation('inference', ['feat:ai:use']).content).toContain(
      'current Assistant model tool does not expose reorder'
    );
    expect(getInternalDocumentation('inference', ['inference:providers:manage']).content).toContain(
      'manage_inference_provider'
    );
    expect(getInternalDocumentation('inference', ['inference:models:manage']).content).toContain(
      'manage_inference_model'
    );
    expect(getInternalDocumentation('status-page', ['status-page:view']).content).toContain('manage_status_page');
    expect(getInternalDocumentation('status-page', ['status-page:view']).content).toContain(
      'status-page:incidents:create'
    );
    expect(getInternalDocumentation('siem', ['audit:siem:view']).content).toContain('custom HTTP header');
    expect(getInternalDocumentation('siem', ['audit:siem:view']).content).toContain('X-Gateway-Signature-256');
    expect(getInternalDocumentation('gitlab', ['integrations:gitlab:view']).content).toContain(
      'gitlab_update_ci_config'
    );
    expect(getInternalDocumentation('gitlab', ['integrations:gitlab:view']).content).toContain('gitlab_sync_connector');
    expect(getInternalDocumentation('gitlab', ['integrations:gitlab:view']).content).toContain(
      'Every GitLab tool except gitlab_list_connectors requires the exact connectorId UUID'
    );
    expect(getInternalDocumentation('gitlab', ['integrations:gitlab:view']).content).toContain('masked metadata only');
  });

  it('documents Cloudflare DNS-01 issuance and auto-renew for SSL certificates', () => {
    expect(INTERNAL_DOCS.ssl).toContain('dnsProvider: "cloudflare"');
    expect(INTERNAL_DOCS.ssl).toContain('set_auto_renew');
    expect(INTERNAL_DOCS.acme).toContain('Cloudflare dns-01');
    expect(INTERNAL_DOCS.acme).toContain('DNS-01 auto-renew requires Cloudflare');
  });

  it('does not regress to stale model-facing tool names or enum examples', () => {
    const allDocs = Object.values(INTERNAL_DOCS).join('\n');

    expect(allDocs).not.toContain('upload_ssl_cert');
    expect(allDocs).not.toContain('createDomain');
    expect(allDocs).not.toContain('checkDns');
    expect(allDocs).not.toContain('update_user(');
    expect(allDocs).not.toContain('reverse-proxy');
    expect(allDocs).not.toContain('static-site');
    expect(allDocs).not.toContain('Satisfy Mode');
    expect(allDocs).not.toContain('status-page:incidents:*');
    expect(INTERNAL_DOCS.databases).not.toContain('deploy_managed_database');
    expect(INTERNAL_DOCS.databases).not.toContain('publish_managed_database');
  });

  it('filters unknown-topic suggestions and denies unauthorized topics', () => {
    expect(getInternalDocumentation('docker', ['feat:ai:use'])).toEqual({
      topic: 'docker',
      content: 'You do not have permission to access documentation for "docker".',
    });

    const unknown = getInternalDocumentation('missing', ['feat:ai:use']);
    expect(unknown.topic).toBe('missing');
    expect(unknown.content).toContain('Unknown topic "missing".');
    expect(unknown.content).toContain('permissions');
    expect(unknown.content).toContain('api');
    expect(unknown.content).not.toContain('docker');
    expect(unknown.content).not.toContain('proxy');
  });
});
