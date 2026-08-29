import { describe, expect, it } from 'vitest';
import { DOC_TOPIC_SCOPES, getInternalDocumentation, INTERNAL_DOCS } from '@/modules/ai/ai.docs.js';
import { AI_TOOLS } from '@/modules/ai/ai.tools.js';

const EXPECTED_TOPICS = [
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
] as const;

describe('AI internal docs registry', () => {
  it('publishes the complete topic set through both documentation tools', () => {
    expect(new Set(Object.keys(INTERNAL_DOCS))).toEqual(new Set(EXPECTED_TOPICS));

    for (const toolName of ['internal_documentation', 'read_gateway_documentation']) {
      const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool).toBeDefined();
      const parameters = tool?.parameters as { properties: { topic: { enum: string[] } } };
      expect(new Set(parameters.properties.topic.enum)).toEqual(new Set(EXPECTED_TOPICS));
    }

    expect(AI_TOOLS.find((candidate) => candidate.name === 'read_gateway_documentation')?.mcpOnly).toBe(true);
  });

  it.each([
    ['permissions', ['ai:workspace:use']],
    ['discovery', ['mcp:use']],
    ['docker', ['docker:containers:view']],
    ['docker', ['docker:compose:view']],
    ['logging', ['logs:read:environment-1']],
    ['folders', ['nodes:folders:manage']],
    ['node-files', ['nodes:files:read']],
    ['sandbox', ['ai:sandbox:use']],
    ['gateway-settings', ['settings:gateway:view']],
    ['licensing-updates', ['license:view']],
    ['inference', ['feat:ai:use']],
    ['gitlab', ['integrations:gitlab:view']],
    ['notifications', ['audit:siem:view']],
  ])('allows topic %s with an accepted scope', (topic, scopes) => {
    expect(getInternalDocumentation(topic, scopes)).toEqual({
      topic,
      content: INTERNAL_DOCS[topic],
    });
  });

  it.each([
    ['docker', ['ai:workspace:use']],
    ['proxy', ['pages:view']],
    ['inference', ['databases:view']],
    ['siem', ['notifications:view']],
  ])('denies topic %s without a matching scope', (topic, scopes) => {
    expect(getInternalDocumentation(topic, scopes)).toEqual({
      topic,
      content: `You do not have permission to access documentation for "${topic}".`,
    });
  });

  it('keeps representative scope contracts aligned with product authorization', () => {
    expect(DOC_TOPIC_SCOPES).toMatchObject({
      discovery: ['ai:workspace:use', 'mcp:use'],
      docker: ['docker:containers:view', 'docker:compose:view'],
      'node-files': ['nodes:files:read', 'nodes:files:write'],
      sandbox: 'ai:sandbox:use',
      'gateway-settings': ['settings:gateway:view', 'settings:gateway:edit'],
      'licensing-updates': ['license:view', 'license:manage', 'admin:update'],
      gitlab: 'integrations:gitlab:view',
      siem: 'audit:siem:view',
      proxy: 'proxy:view',
      pages: 'pages:view',
    });
  });

  it.each([
    ['permissions', '# Permissions'],
    ['discovery', 'discover_tools'],
    ['docker', 'Gateway-managed local volumes'],
    ['docker', 'Container IDs change after recreate'],
    ['databases', 'never reveal owner or binding credentials'],
    ['databases', 'private connector and authenticated Gateway tunnel'],
    ['sandbox', 'Artifact tool path arguments are relative to /workspace'],
    ['api', 'manage_api_token'],
    ['authentication', 'email one-time-code'],
    ['docker-registries', 'trusted HTTPS token-service origin'],
    ['inference', '/api/inference/v1/messages'],
    ['gitlab', 'masked metadata only'],
    ['notifications', '{{notification.title}}'],
    ['troubleshooting', 'Never invent a successful recovery'],
  ])('retains the %s safety or workflow contract', (topic, requiredText) => {
    expect(INTERNAL_DOCS[topic]).toContain(requiredText);
  });

  it('does not expose stale or unsafe model-facing guidance', () => {
    const allDocs = Object.values(INTERNAL_DOCS).join('\n');

    for (const staleText of [
      'upload_ssl_cert',
      'createDomain',
      'checkDns',
      'update_user(',
      'reverse-proxy',
      'static-site',
      'Satisfy Mode',
      'status-page:incidents:*',
    ]) {
      expect(allDocs).not.toContain(staleText);
    }

    expect(INTERNAL_DOCS.databases).not.toContain('deploy_managed_database');
    expect(INTERNAL_DOCS.databases).not.toContain('publish_managed_database');
  });

  it('filters unknown-topic suggestions by the caller scopes', () => {
    const unknown = getInternalDocumentation('missing', ['ai:workspace:use']);

    expect(unknown.topic).toBe('missing');
    expect(unknown.content).toContain('Unknown topic "missing".');
    expect(unknown.content).toContain('permissions');
    expect(unknown.content).toContain('api');
    expect(unknown.content).not.toContain('docker');
    expect(unknown.content).not.toContain('proxy');
  });
});
