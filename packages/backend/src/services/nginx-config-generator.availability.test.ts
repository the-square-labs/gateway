import { describe, expect, it } from 'vitest';
import { NginxConfigGenerator } from './nginx-config-generator.service.js';

describe('NginxConfigGenerator Availability upstreams', () => {
  it('balances new connections across active placement Secure Link sockets', () => {
    const generator = new NginxConfigGenerator({ validate: () => ({ valid: true, errors: [] }) } as never);
    const config = generator.generateConfig({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'proxy',
      domainNames: ['app.example.test'],
      enabled: true,
      forwardHost: '127.0.0.1',
      forwardPort: 1,
      forwardScheme: 'http',
      secureLinkUpstream: true,
      secureLinkSocketPath: '/run/gateway-secure-links/primary.sock',
      secureLinkSocketPaths: [
        '/run/gateway-secure-links/placement-a.sock',
        '/run/gateway-secure-links/placement-b.sock',
      ],
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
      advancedConfig: null,
      accessList: null,
      sslCertPath: null,
      sslKeyPath: null,
      sslChainPath: null,
    });
    expect(config).toContain('least_conn;');
    expect(config).toContain('server unix:/run/gateway-secure-links/placement-a.sock;');
    expect(config).toContain('server unix:/run/gateway-secure-links/placement-b.sock;');
    expect(config).not.toContain('server unix:/run/gateway-secure-links/primary.sock;');
  });
});
