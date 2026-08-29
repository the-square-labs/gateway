import { describe, expect, it, vi } from 'vitest';
import { ConfigValidatorService } from '@/services/config-validator.service.js';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';

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
