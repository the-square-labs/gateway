import { describe, expect, it, vi } from 'vitest';
import { NginxConfigGenerator, type ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService, normalizeAcmeChallengeAlias } from './nginx-template.service.js';
import { CreateProxyHostSchema, UpdateProxyHostSchema } from './proxy.schemas.js';

vi.mock('@/db/schema/proxy-hosts.js', () => ({ proxyHosts: { nginxTemplateId: 'nginx_template_id' } }));
vi.mock('@/db/schema/nginx-templates.js', () => ({
  nginxTemplates: { id: 'nginx_templates.id', type: 'nginx_templates.type', isBuiltin: 'nginx_templates.is_builtin' },
}));

// nginx-daemon writes tokens to <acme_challenge_dir>/.well-known/acme-challenge/<token>
// (handler_sync.go), matching the setup-node.sh catch-all server.
const DAEMON_ALIAS = 'alias /var/www/acme-challenge/.well-known/acme-challenge/;';
const LEGACY_ALIAS = 'alias /var/www/acme-challenge/;';

const host: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: '10.0.0.2',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: false,
  http2Support: true,
  websocketSupport: false,
  redirectUrl: 'https://target.example.com',
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: { id: 'list-1', ipRules: [{ type: 'deny', value: 'all' }], basicAuthEnabled: true },
  sslCertPath: '/etc/nginx/certs/example.crt',
  sslKeyPath: '/etc/nginx/certs/example.key',
  sslChainPath: null,
};

function templateService(customContent?: string) {
  return new NginxTemplateService(
    {
      query: {
        nginxTemplates: {
          findFirst: async () =>
            customContent ? { id: 'template-1', type: 'proxy', isBuiltin: false, content: customContent } : undefined,
        },
      },
    } as any,
    {} as any
  );
}

describe('HTTP-01 challenge location', () => {
  it.each([
    ['proxy', { sslForced: false }],
    ['proxy', { sslForced: true }],
    ['redirect', { sslForced: false }],
    ['redirect', { sslForced: true }],
    ['404', { sslForced: false }],
  ] as const)('built-in %s template serves the daemon token directory (%o)', async (type, overrides) => {
    const rendered = await templateService().renderForHost({ ...host, type, ...overrides }, null);

    expect(rendered).toContain('location /.well-known/acme-challenge/ {');
    expect(rendered).toContain(DAEMON_ALIAS);
    expect(rendered).not.toContain(LEGACY_ALIAS);
  });

  it('rewrites the legacy alias in custom templates cloned before the fix', async () => {
    const custom = `server {
    listen 80;
    server_name {{serverNames}};
    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/;
    }
}
`;
    const rendered = await templateService(custom).renderForHost(host, 'template-1');

    expect(rendered).toContain(DAEMON_ALIAS);
    expect(rendered).not.toContain(LEGACY_ALIAS);
    expect(normalizeAcmeChallengeAlias('alias /var/www/acme-challenge/;')).toBe('alias /var/www/acme-challenge/;');
  });

  it.each([
    { ...host, type: 'proxy' as const, sslForced: false },
    { ...host, type: 'proxy' as const, sslForced: true },
    { ...host, type: 'redirect' as const, sslForced: false },
  ])('legacy config generator uses the daemon token directory', (config) => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig(config);

    expect(rendered).toContain(DAEMON_ALIAS);
    expect(rendered).not.toContain(LEGACY_ALIAS);
  });
});

describe('template variables cannot override managed values', () => {
  it('renders managed values even when stored variables use reserved names', async () => {
    const custom = `upstream={{upstream}}
acl={{#if accessList}}on{{else}}off{{/if}}
key={{sslKeyPath}}
log={{logPath}}
custom={{customFlag}}
cache={{cacheEnabled}}
`;
    const rendered = await templateService(custom).renderForHost(
      {
        ...host,
        templateVariables: {
          accessList: false,
          upstream: 'http://attacker.example:80',
          sslKeyPath: '/etc/shadow',
          logPath: '/tmp/stolen',
          customFlag: 'kept',
          cacheEnabled: true,
        },
      },
      'template-1'
    );

    expect(rendered).toContain('upstream=http://10.0.0.2:8080');
    expect(rendered).toContain('acl=on');
    expect(rendered).toContain('key=/etc/nginx/certs/example.crt'.replace('.crt', '.key'));
    expect(rendered).toContain(`log=/var/log/nginx/proxy-${host.id}`);
    expect(rendered).toContain('custom=kept');
    // Documented template overrides keep working.
    expect(rendered).toContain('cache=true');
  });

  // Regression: custom templates that declare reserved names send them back, and the 400 made
  // their settings unsaveable. Reserved keys are dropped instead; they are ignored at render anyway.
  it('drops reserved template variable names on create and update', () => {
    const create = CreateProxyHostSchema.safeParse({
      nodeId: '11111111-1111-4111-8111-111111111111',
      domainNames: ['example.com'],
      forwardHost: 'app',
      forwardPort: 80,
      templateVariables: { accessList: false, myFlag: 'x' },
    });
    expect(create.success).toBe(true);
    expect(create.data?.templateVariables).toEqual({ myFlag: 'x' });

    const update = UpdateProxyHostSchema.safeParse({ templateVariables: { upstream: 'x', sslKeyPath: 'y' } });
    expect(update.success).toBe(true);
    expect(update.data?.templateVariables).toEqual({});

    const kept = UpdateProxyHostSchema.safeParse({
      templateVariables: { cacheEnabled: true, rateLimitRPS: 5, myFlag: 'x' },
    });
    expect(kept.data?.templateVariables).toEqual({ cacheEnabled: true, rateLimitRPS: 5, myFlag: 'x' });
  });
});
