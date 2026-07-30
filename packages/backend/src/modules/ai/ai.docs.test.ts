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
      'nginx',
      'nodes',
      'housekeeping',
      'permissions',
      'docker',
      'databases',
      'postgres',
      'redis',
      'logging',
      'folders',
      'node-files',
      'sandbox',
      'conversations',
      'status-page',
      'api',
      'inference',
      'ai-settings',
      'gitlab',
      'notifications',
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
      gitlab: 'integrations:gitlab:view',
      notifications: 'notifications:view',
      proxy: 'proxy:view',
      inference: expect.arrayContaining(['inference:use', 'inference:providers:manage', 'inference:models:manage']),
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
    expect(getInternalDocumentation('api', ['feat:ai:use']).content).toContain('manage_oauth_authorization');
    expect(getInternalDocumentation('api', ['feat:ai:use']).content).toContain('manage_api_token');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).toContain('update_ai_settings');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).toContain('providerUrl');
    expect(getInternalDocumentation('ai-settings', ['feat:ai:configure']).content).not.toContain('baseUrl:');
    expect(getInternalDocumentation('inference', ['inference:use']).content).toContain(
      'npx @wiolett/gateway-inference setup codex'
    );
    expect(getInternalDocumentation('inference', ['inference:use']).content).toContain('/api/inference/openai/v1');
    expect(getInternalDocumentation('inference', ['inference:use']).content).toContain(
      '/api/inference/anthropic/v1/messages'
    );
    expect(getInternalDocumentation('inference', ['inference:use']).content).toContain(
      'Profile > Authorizations > Inference API tokens'
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
