import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';

// Grant cleanup on delete is covered against PostgreSQL in resource-scope-cleanup.database.test.ts.
vi.mock('@/lib/resource-scope-cleanup.js', () => ({
  transactionWithScopeCleanup: (db: any, work: (tx: any) => unknown) =>
    db.transaction ? db.transaction(work) : work(db),
}));
vi.mock('@/db/schema/proxy-hosts.js', () => ({ proxyHosts: { nginxTemplateId: 'nginx_template_id' } }));
vi.mock('@/db/schema/nginx-templates.js', () => ({
  nginxTemplates: { id: 'nginx_templates.id', type: 'nginx_templates.type', isBuiltin: 'nginx_templates.is_builtin' },
}));

const host: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: 'app',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: false,
  sslForced: false,
  http2Support: false,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: '{{directive}} /etc/nginx/conf.d/*.conf;',
  templateVariables: { directive: 'include' },
  accessList: null,
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

function service() {
  return new NginxTemplateService({} as never, {} as never, new ConfigValidatorService());
}

describe('NginxTemplateService advanced config rendering', () => {
  it('rejects forbidden directives assembled through template variables', () => {
    expect(() => service().renderTemplate('server { {{{advancedConfig}}} }', host)).toThrow(
      'Rendered advanced config is unsafe'
    );
  });

  it('preserves safe advanced config interpolation', () => {
    const rendered = service().renderTemplate('server { {{{advancedConfig}}} }', {
      ...host,
      advancedConfig: 'add_header X-Upstream "{{forwardHost}}";',
    });
    expect(rendered).toContain('add_header X-Upstream "app";');
  });
});

describe('NginxTemplateService custom rewrites', () => {
  const rewriteHost: ProxyHostConfig = {
    ...host,
    advancedConfig: null,
    templateVariables: {},
    customRewrites: [{ source: '^/old-shop/(.*)$', destination: '/$1', type: 'permanent' }],
  };

  it('keeps regex anchors and capture references in the built-in template', async () => {
    const db = { query: { nginxTemplates: { findFirst: async () => undefined } } };
    const rendered = await new NginxTemplateService(
      db as never,
      {} as never,
      new ConfigValidatorService()
    ).renderForHost(rewriteHost, null);

    expect(rendered).toContain('rewrite ^/old-shop/(.*)$ /$1 permanent;');
  });

  it('upgrades custom templates cloned before regex rewrites worked', () => {
    const legacy =
      '{{#each customRewrites}}rewrite {{sanitize this.source}} {{sanitize this.destination}} redirect;{{/each}}';

    expect(service().renderTemplate(legacy, rewriteHost)).toBe('rewrite ^/old-shop/(.*)$ /$1 redirect;');
  });

  it('still removes characters that would end or break out of the directive', () => {
    const rendered = service().renderTemplate(
      '{{#each customRewrites}}rewrite {{sanitizeRewrite this.source}} {{sanitizeRewrite this.destination}};{{/each}}',
      {
        ...rewriteHost,
        customRewrites: [{ source: '^/a$; return 200 "x"; #', destination: '/b{}`\n', type: 'temporary' }],
      }
    );

    expect(rendered).toBe('rewrite ^/a$ return 200 x  /b;');
  });
});
