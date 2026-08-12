import { describe, expect, it, vi } from 'vitest';
import {
  escapeNginxReturnText,
  GATEWAY_MAINTENANCE_HTML,
  GATEWAY_NOT_FOUND_HTML,
  gatewayMaintenanceHtml,
  gatewayNotFoundHtml,
} from '@/lib/gateway-error-pages.js';
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
  forwardHost: '10.0.0.2',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: true,
  http2Support: true,
  websocketSupport: true,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [{ name: 'X-Test', value: 'yes' }],
  cacheEnabled: true,
  cacheOptions: { maxAge: 60 },
  rateLimitEnabled: true,
  rateLimitOptions: { requestsPerSecond: 10, burst: 20, connectionsPerIp: 30 },
  customRewrites: [{ source: '^/old', destination: '/new', type: 'permanent' }],
  advancedConfig: 'add_header X-Advanced yes;',
  accessList: { id: 'list-1', ipRules: [{ type: 'allow', value: '10.0.0.0/8' }], basicAuthEnabled: true },
  sslCertPath: '/etc/nginx/certs/example.crt',
  sslKeyPath: '/etc/nginx/certs/example.key',
  sslChainPath: '/etc/nginx/certs/example.chain.crt',
};

function service() {
  return new NginxTemplateService(
    { query: { nginxTemplates: { findFirst: async () => undefined } } } as any,
    {} as any
  );
}

describe('canonical Gateway nginx pages', () => {
  it('uses the shared minimal error-page layout without the Gateway header', () => {
    for (const page of [GATEWAY_NOT_FOUND_HTML, GATEWAY_MAINTENANCE_HTML]) {
      expect(page).toContain('Powered by <a href="https://wiolett.net"');
      expect(page).toContain('font-size:clamp(40px,8vw,64px)');
      expect(page).not.toContain('Self-hosted infrastructure control plane');
      expect(page).not.toContain('class="brand"');
      expect(page).not.toContain('class="card"');
    }
  });

  it('uses the browser prompt for maintenance team access', () => {
    expect(GATEWAY_MAINTENANCE_HTML).toContain("window.prompt('Access code')");
    expect(GATEWAY_MAINTENANCE_HTML).not.toContain('<dialog');
    expect(GATEWAY_MAINTENANCE_HTML).not.toContain('maintenance-access-form');
  });

  it('removes only external branding when configured', () => {
    expect(gatewayNotFoundHtml(true)).not.toContain('Powered by');
    expect(gatewayMaintenanceHtml(true)).not.toContain('Powered by');
    expect(gatewayMaintenanceHtml(true)).toContain('Team access');
    expect(gatewayMaintenanceHtml(true)).toContain("window.prompt('Access code')");
  });

  it('injects maintenance before location handling without rebuilding the TLS vhost', async () => {
    const templateService = service();
    const normalConfig = await templateService.renderForHost(host, null);
    const rendered = templateService.applyMaintenanceGuard(normalConfig);

    expect(rendered).toContain('listen 80;');
    expect(rendered).toContain('listen 443 ssl;');
    expect(rendered).toContain('http2 on;');
    expect(rendered.match(/server \{/g)).toHaveLength(2);
    expect(rendered.match(/# Gateway maintenance mode/g)).toHaveLength(2);
    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/example.crt;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/example.key;');
    expect(rendered).toContain('location /.well-known/acme-challenge/');
    expect(rendered).toContain('if ($uri !~ ^/\\.well-known/acme-challenge/)');
    expect(rendered).toContain('return 503');
    expect(rendered).toContain('Cache-Control "no-store" always');
    expect(rendered).toContain(escapeNginxReturnText(GATEWAY_MAINTENANCE_HTML));
    expect(rendered).toContain('proxy_pass http://10.0.0.2:8080;');
    expect(rendered).toContain('X-Advanced');
    expect(rendered.indexOf('# Gateway maintenance mode')).toBeLessThan(rendered.indexOf('location /'));
  });

  it('adds a daemon-owned access route and strips its bypass cookie without changing the stored template', async () => {
    const templateService = service();
    const normalConfig = await templateService.renderForHost(
      {
        ...host,
        advancedConfig:
          'location /api/ { proxy_set_header Cookie application_cookie; proxy_pass http://10.0.0.3:8080; }',
      },
      null
    );
    const rendered = templateService.applyMaintenanceGuard(normalConfig, {
      hostId: host.id,
      secret: 'maintenance-secret',
    });

    expect(normalConfig).toContain('proxy_set_header Cookie application_cookie;');
    expect(rendered).not.toContain('proxy_set_header Cookie application_cookie;');
    expect(rendered).toContain('location = /_gateway/maintenance-access');
    expect(rendered).toContain(
      'proxy_pass http://unix:/run/nginx-daemon/maintenance-access.sock:/redeem/11111111-1111-4111-8111-111111111111;'
    );
    expect(rendered).toContain(
      'secure_link "$cookie_gateway_maintenance_access_sig,$cookie_gateway_maintenance_access_exp";'
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Nginx variables are asserted as literal configuration text.
    expect(rendered).toContain('secure_link_md5 "${secure_link_expires}${host}maintenance-secret";');
    expect(rendered).not.toContain('$hostmaintenance-secret');
    expect(rendered).toContain('map "$uri:$secure_link" $gm_block_11111111_1111_4111_8111_111111111111');
    expect(rendered).toContain('proxy_set_header Cookie $gm_cookie_11111111_1111_4111_8111_111111111111;');
  });

  it('leaves TLS policy to the shared Nginx configuration for SNI-origin compatibility', async () => {
    const rendered = await service().renderForHost(host, null);

    expect(rendered).toContain('listen 443 ssl;');
    expect(rendered).toContain('http2 on;');
    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/example.crt;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/example.key;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).not.toContain('ssl_session_');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/example.chain.crt;');
  });

  it('renders the two-hour Secure Link inactivity timeout through the production template path', async () => {
    const secure = await service().renderForHost({ ...host, secureLinkUpstream: true }, null);
    const regular = await service().renderForHost(host, null);

    expect(secure).toContain('proxy_send_timeout 2h;');
    expect(secure).toContain('proxy_read_timeout 2h;');
    expect(secure).toContain('# gateway-managed-secure-link-upstream');
    expect(secure).toContain('upstream gateway_secure_link_11111111_1111_4111_8111_111111111111');
    expect(secure).toContain('server unix:/run/gateway-secure-links/11111111-1111-4111-8111-111111111111.sock;');
    expect(secure).toContain('keepalive 64;');
    expect(secure).toContain('proxy_pass http://gateway_secure_link_11111111_1111_4111_8111_111111111111;');
    expect(regular).toContain('proxy_send_timeout 60s;');
    expect(regular).toContain('proxy_read_timeout 60s;');
    expect(regular).not.toContain('# gateway-managed-secure-link-upstream');
  });

  it('adds the managed Secure Link upstream to legacy custom templates', async () => {
    const legacyTemplate = `server {
    listen 80;
    server_name {{serverNames}};
    location / {
        proxy_pass {{upstream}};
    }
}`;
    const templateService = new NginxTemplateService(
      {
        query: {
          nginxTemplates: {
            findFirst: async () => ({ id: 'legacy-template', content: legacyTemplate }),
          },
        },
      } as any,
      {} as any
    );

    const rendered = await templateService.renderForHost(
      { ...host, secureLinkUpstream: true, sslEnabled: false, sslForced: false },
      'legacy-template'
    );

    expect(rendered.match(/upstream gateway_secure_link_11111111_1111_4111_8111_111111111111/g)).toHaveLength(1);
    expect(rendered).toContain('server unix:/run/gateway-secure-links/11111111-1111-4111-8111-111111111111.sock;');
    expect(rendered).toContain('proxy_pass http://gateway_secure_link_11111111_1111_4111_8111_111111111111;');
  });

  it('renders additional Secure Link variables and their managed Unix upstreams', async () => {
    const bindingId = '22222222-2222-4222-8222-222222222222';
    const rendered = await service().renderForHost(
      {
        ...host,
        advancedConfig: 'location /api/ { proxy_pass {{additionalSecureLinks.api}}; }',
        additionalSecureLinks: [
          {
            id: bindingId,
            name: 'api',
            scheme: 'http',
            socketPath: `/run/gateway-secure-links/${bindingId}.sock`,
          },
        ],
      },
      null
    );

    expect(rendered).toContain('upstream gateway_additional_secure_link_22222222_2222_4222_8222_222222222222');
    expect(rendered).toContain(`server unix:/run/gateway-secure-links/${bindingId}.sock;`);
    expect(rendered).toContain(
      'proxy_pass http://gateway_additional_secure_link_22222222_2222_4222_8222_222222222222;'
    );
    expect(rendered.match(/upstream gateway_additional_secure_link_/g)).toHaveLength(1);
  });

  it('inherits the production per-IP request limit and allows explicit disable', async () => {
    const inherited = await service().renderForHost(
      { ...host, rateLimitEnabled: false, rateLimitMode: 'inherit' },
      null
    );
    const disabled = await service().renderForHost(
      { ...host, rateLimitEnabled: false, rateLimitMode: 'disabled' },
      null
    );

    expect(inherited).toContain('rate=1000r/s;');
    expect(inherited).toContain('burst=3000 nodelay;');
    expect(inherited).toContain('limit_conn_zone $binary_remote_addr zone=connlimit_');
    expect(inherited).toContain('limit_conn connlimit_11111111-1111-4111-8111-111111111111 1000;');
    expect(inherited).toContain('limit_conn_status 429;');
    expect(inherited).toContain('limit_req_status 429;');
    expect(disabled).not.toContain('limit_req_zone');
    expect(disabled).not.toContain('limit_req zone=');
    expect(disabled).not.toContain('limit_conn_zone');
    expect(disabled).not.toContain('limit_conn connlimit_');
  });

  it('renders a custom per-IP concurrent connection limit', async () => {
    const rendered = await service().renderForHost({ ...host, rateLimitMode: 'custom' }, null);

    expect(rendered).toContain('rate=10r/s;');
    expect(rendered).toContain('burst=20 nodelay;');
    expect(rendered).toContain('limit_conn connlimit_11111111-1111-4111-8111-111111111111 30;');
  });

  it('uses managed template variables as the canonical cache and traffic policy', async () => {
    const rendered = await service().renderForHost(
      {
        ...host,
        cacheEnabled: false,
        cacheOptions: { maxAge: 60 },
        rateLimitEnabled: false,
        rateLimitMode: 'disabled',
        templateVariables: {
          cacheEnabled: true,
          cacheMaxAge: 7200,
          rateLimitMode: 'custom',
          rateLimitRPS: 321,
          rateLimitBurst: 654,
          connectionsPerIp: 987,
        },
      },
      null
    );

    expect(rendered).toContain('inactive=7200s;');
    expect(rendered).toContain('proxy_cache_valid 200 301 302 7200s;');
    expect(rendered).toContain('rate=321r/s;');
    expect(rendered).toContain('burst=654 nodelay;');
    expect(rendered).toContain('limit_conn connlimit_11111111-1111-4111-8111-111111111111 987;');
  });

  it.each(['redirect', '404'] as const)('uses the same shared TLS policy for built-in %s hosts', async (type) => {
    const template = await service().getBuiltinTemplateContent(type);
    const rendered = service().renderTemplate(template, { ...host, type });

    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/example.crt;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/example.key;');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/example.chain.crt;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).not.toContain('ssl_session_');
  });

  it('applies a basic-auth-only ACL to the upstream location without emitting deny all', async () => {
    const rendered = await service().renderForHost(
      { ...host, accessList: { id: 'basic-only', ipRules: [], basicAuthEnabled: true } },
      null
    );

    expect(rendered).not.toContain('deny all;');
    expect(rendered).toMatch(
      /location \/ \{[\s\S]*auth_basic "Restricted Access";[\s\S]*auth_basic_user_file \/etc\/nginx\/gateway\/htpasswd\/access-list-basic-only;[\s\S]*proxy_pass/
    );
  });

  it('adds the host ACL to advanced locations without applying it to ACME challenges', async () => {
    const rendered = await service().renderForHost(
      {
        ...host,
        sslForced: false,
        advancedConfig: `location /api/ {
    proxy_pass http://127.0.0.1:9000;
}`,
      },
      null
    );
    const upstreamLocation = rendered.lastIndexOf('location / {');
    const advancedLocation = rendered.indexOf('location /api/ {');
    const acmeLocation = rendered.indexOf('location /.well-known/acme-challenge/ {');
    const denyAll = rendered.indexOf('deny all;');
    const rootEnd = rendered.indexOf('\n    }', upstreamLocation);
    const advancedEnd = rendered.indexOf('\n    }', advancedLocation);
    const acmeEnd = rendered.indexOf('\n    }', acmeLocation);
    const rootConfig = rendered.slice(upstreamLocation, rootEnd);
    const advancedConfig = rendered.slice(advancedLocation, advancedEnd);
    const acmeConfig = rendered.slice(acmeLocation, acmeEnd);

    expect(denyAll).toBeGreaterThan(upstreamLocation);
    expect(upstreamLocation).toBeLessThan(advancedLocation);
    expect(rendered.slice(0, upstreamLocation)).not.toContain('deny all;');
    for (const config of [rootConfig, advancedConfig]) {
      expect(config).toContain('allow 10.0.0.0/8;');
      expect(config).toContain('deny all;');
      expect(config).toContain('auth_basic "Restricted Access";');
    }
    expect(acmeConfig).toContain('auth_basic off;');
    expect(acmeConfig).not.toContain('deny all;');
  });

  it('preserves custom listen and certificate directives byte-for-byte', () => {
    const original = `server {
    listen 7443 ssl;
    ssl_certificate /custom/live/fullchain.pem;
    ssl_certificate_key /custom/live/privkey.pem;
    location / { proxy_pass https://upstream; }
}`;
    const rendered = service().applyMaintenanceGuard(original);

    expect(rendered).toContain('listen 7443 ssl;');
    expect(rendered).toContain('ssl_certificate /custom/live/fullchain.pem;');
    expect(rendered).toContain('ssl_certificate_key /custom/live/privkey.pem;');
  });

  it('rejects maintenance injection when a rendered config has no server block', () => {
    expect(() => service().applyMaintenanceGuard('upstream backend { server 10.0.0.2:8080; }')).toThrow(
      'Rendered proxy config has no server block'
    );
  });

  it('uses the canonical branded body for the built-in 404 template', async () => {
    const template = await service().getBuiltinTemplateContent('404');
    const rendered = service().renderTemplate(template, { ...host, type: '404' });
    expect(rendered).toContain('return 404');
    expect(rendered).toContain(GATEWAY_NOT_FOUND_HTML);
    expect(rendered).not.toContain('/usr/share/nginx/html');
  });
});
