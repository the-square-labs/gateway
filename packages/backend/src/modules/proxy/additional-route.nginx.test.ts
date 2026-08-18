import { describe, expect, it, vi } from 'vitest';
import type { ProxyHostConfig } from '@/services/nginx-config-generator.service.js';
import { NginxTemplateService } from './nginx-template.service.js';

vi.mock('@/db/schema/proxy-hosts.js', () => ({ proxyHosts: { nginxTemplateId: 'nginx_template_id' } }));
vi.mock('@/db/schema/nginx-templates.js', () => ({
  nginxTemplates: { id: 'nginx_templates.id', type: 'nginx_templates.type', isBuiltin: 'nginx_templates.is_builtin' },
}));

const baseHost: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['example.com'],
  enabled: true,
  forwardHost: '127.0.0.1',
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
  rateLimitEnabled: true,
  rateLimitMode: 'inherit',
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: {
    id: 'list-1',
    ipRules: [{ type: 'allow', value: '10.0.0.0/8' }],
    basicAuthEnabled: true,
  },
  sslCertPath: null,
  sslKeyPath: null,
  sslChainPath: null,
};

function service(template?: { content: string; isBuiltin?: boolean; type?: string }) {
  return new NginxTemplateService(
    {
      query: {
        nginxTemplates: { findFirst: async () => template },
      },
    } as any,
    {} as any
  );
}

describe('managed Additional Route rendering', () => {
  it('emits exact and descendant locations in longest-path order with inherited protections', async () => {
    const rendered = await service().renderForHost(
      {
        ...baseHost,
        additionalRoutes: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            path: '/api',
            targetKind: 'manual',
            forwardScheme: 'http',
            forwardHost: '10.0.0.2',
            forwardPort: 9000,
            stripPrefix: true,
            websocketSupport: true,
            requestBuffering: false,
            responseBuffering: true,
            connectTimeoutSeconds: 10,
            readTimeoutSeconds: 20,
            sendTimeoutSeconds: 30,
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            path: '/api/v2',
            targetKind: 'manual',
            forwardScheme: 'https',
            forwardHost: '10.0.0.3',
            forwardPort: 9443,
            stripPrefix: false,
            websocketSupport: false,
            requestBuffering: true,
            responseBuffering: false,
            connectTimeoutSeconds: 1,
            readTimeoutSeconds: 2,
            sendTimeoutSeconds: 3,
          },
        ],
      },
      null
    );

    expect(rendered.indexOf('location = /api/v2')).toBeLessThan(rendered.indexOf('location = /api {'));
    expect(rendered).toContain('location ^~ /api/v2/ {');
    expect(rendered).not.toContain('location /apix');
    expect(rendered).toContain('proxy_pass http://10.0.0.2:9000/;');
    expect(rendered).toContain('proxy_pass https://10.0.0.3:9443;');
    expect(rendered).toContain('proxy_request_buffering off;');
    expect(rendered).toContain('proxy_buffering off;');
    expect(rendered).toContain('proxy_connect_timeout 10s;');
    expect(rendered).toContain('proxy_read_timeout 20s;');
    expect(rendered).toContain('proxy_send_timeout 30s;');
    expect(rendered.match(/auth_basic "Restricted Access";/g)).toHaveLength(5);
    expect(rendered.match(/limit_req zone=ratelimit_/g)).toHaveLength(5);
  });

  it('scopes Pages runtime config and keeps dot-file denial effective', async () => {
    const rendered = await service().renderForHost(
      {
        ...baseHost,
        additionalRoutes: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            path: '/docs',
            targetKind: 'pages',
            forwardScheme: 'http',
            forwardHost: null,
            forwardPort: null,
            pagesRouteIncludePath: '/var/lib/nginx/pages/routes/44444444-4444-4444-8444-444444444444.inc',
            pagesRuntimeConfigPath:
              '/var/lib/nginx/pages/runtime-configs/routes/44444444-4444-4444-8444-444444444444/current.js',
            stripPrefix: true,
            websocketSupport: false,
            requestBuffering: false,
            responseBuffering: false,
            connectTimeoutSeconds: 60,
            readTimeoutSeconds: 60,
            sendTimeoutSeconds: 60,
          },
        ],
      },
      null
    );

    expect(rendered).toContain('location = /docs {');
    expect(rendered).toContain('return 308 /docs/;');
    expect(rendered).toContain('location = /docs/_gateway/pages/config.js');
    expect(rendered).toContain('include /var/lib/nginx/pages/routes/44444444-4444-4444-8444-444444444444.inc;');
    expect(rendered).toContain(
      'alias /var/lib/nginx/pages/runtime-configs/routes/44444444-4444-4444-8444-444444444444/current.js;'
    );
    expect(rendered).not.toContain('alias $gateway_pages_runtime_config_path;');
    expect(rendered).toContain('location /docs/ {');
    expect(rendered).not.toContain('location ^~ /docs/ {');
    expect(rendered).toContain('location ~ ^/docs/\\. { deny all; }');
    expect(rendered).toContain(
      "sub_filter '</head>' '<script src=\"/docs/_gateway/pages/config.js\"></script></head>';"
    );
    expect(rendered).not.toContain('proxy_pass http://10.0.0.2');
    expect(rendered).not.toContain('proxy_pass https://10.0.0.3');
  });

  it('does not inject route locations or route upstreams into custom templates', async () => {
    const custom = `server {\n    listen 80;\n    location / { proxy_pass http://backend; }\n}`;
    const rendered = await service({ content: custom, isBuiltin: false, type: 'proxy' }).renderForHost(
      {
        ...baseHost,
        additionalRoutes: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            path: '/api',
            targetKind: 'docker_container',
            forwardScheme: 'http',
            forwardHost: '127.0.0.1',
            forwardPort: 8080,
            secureLinkUpstream: true,
            secureLinkSocketPath: '/run/gateway-secure-links/55555555-5555-4555-8555-555555555555.sock',
            stripPrefix: false,
            websocketSupport: false,
            requestBuffering: true,
            responseBuffering: true,
            connectTimeoutSeconds: 60,
            readTimeoutSeconds: 60,
            sendTimeoutSeconds: 60,
          },
        ],
      },
      'custom-template'
    );

    expect(rendered).toContain('proxy_pass http://backend;');
    expect(rendered).not.toContain('location = /api');
    expect(rendered).not.toContain('gateway_additional_secure_link_55555555');
  });
});
