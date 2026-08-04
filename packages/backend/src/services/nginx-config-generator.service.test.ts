import { describe, expect, it } from 'vitest';
import { NginxConfigGenerator, type ProxyHostConfig } from './nginx-config-generator.service.js';

const proxyHost: ProxyHostConfig = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'proxy',
  domainNames: ['origin.example.test'],
  enabled: true,
  forwardHost: '127.0.0.1',
  forwardPort: 8080,
  forwardScheme: 'http',
  sslEnabled: true,
  sslForced: false,
  http2Support: true,
  websocketSupport: false,
  redirectUrl: null,
  redirectStatusCode: 301,
  customHeaders: [],
  cacheEnabled: false,
  cacheOptions: null,
  rateLimitEnabled: false,
  rateLimitOptions: null,
  customRewrites: [],
  advancedConfig: null,
  accessList: { id: 'basic-only', ipRules: [], basicAuthEnabled: true },
  sslCertPath: '/etc/nginx/certs/origin/fullchain.pem',
  sslKeyPath: '/etc/nginx/certs/origin/privkey.pem',
  sslChainPath: '/etc/nginx/certs/origin/chain.pem',
};

describe('NginxConfigGenerator proxy TLS and ACL rendering', () => {
  it('uses shared TLS policy and scopes a basic-auth-only ACL to the upstream', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig(proxyHost);

    expect(rendered).toContain('listen 443 ssl;');
    expect(rendered).toContain('http2 on;');
    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/origin/fullchain.pem;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/origin/privkey.pem;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/origin/chain.pem;');
    expect(rendered).not.toContain('deny all;');
    expect(rendered).toMatch(
      /location \/ \{[\s\S]*auth_basic "Restricted Access";[\s\S]*auth_basic_user_file \/etc\/nginx\/gateway\/htpasswd\/access-list-basic-only;[\s\S]*proxy_pass/
    );
  });

  it('emits IP deny fallback only inside the upstream location', () => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig({
      ...proxyHost,
      accessList: { id: 'ip-only', ipRules: [{ type: 'allow', value: '192.0.2.0/24' }], basicAuthEnabled: false },
    });
    const upstreamLocation = rendered.indexOf('location / {');
    const denyAll = rendered.indexOf('deny all;');

    expect(denyAll).toBeGreaterThan(upstreamLocation);
    expect(rendered.slice(0, upstreamLocation)).not.toContain('deny all;');
  });

  it.each(['redirect', '404'] as const)('uses the same shared TLS policy for %s hosts', (type) => {
    const rendered = new NginxConfigGenerator({} as never).generateConfig({ ...proxyHost, type });

    expect(rendered).toContain('ssl_certificate /etc/nginx/certs/origin/fullchain.pem;');
    expect(rendered).toContain('ssl_certificate_key /etc/nginx/certs/origin/privkey.pem;');
    expect(rendered).toContain('ssl_trusted_certificate /etc/nginx/certs/origin/chain.pem;');
    expect(rendered).not.toContain('ssl_protocols');
    expect(rendered).not.toContain('ssl_ciphers');
    expect(rendered).not.toContain('ssl_session_');
  });
});
