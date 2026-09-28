import { describe, expect, it, vi } from 'vitest';
import { ProxyService } from './proxy.service.js';

vi.mock('@/db/schema/access-lists.js', () => ({ accessLists: { id: 'access_lists.id' } }));
vi.mock('@/db/schema/certificates.js', () => ({ certificates: { id: 'certificates.id' } }));
vi.mock('@/db/schema/ssl-certificates.js', () => ({ sslCertificates: { id: 'ssl_certificates.id' } }));
vi.mock('@/db/schema/index.js', () => ({
  nodes: {
    id: 'nodes.id',
    hostname: 'nodes.hostname',
    displayName: 'nodes.display_name',
    status: 'nodes.status',
  },
  proxyHosts: {
    id: 'proxy_hosts.id',
    enabled: 'proxy_hosts.enabled',
    isSystem: 'proxy_hosts.is_system',
    nodeId: 'proxy_hosts.node_id',
    nginxTemplateId: 'proxy_hosts.nginx_template_id',
    upstreamKind: 'proxy_hosts.upstream_kind',
    secureLinkStatus: 'proxy_hosts.secure_link_status',
    type: 'proxy_hosts.type',
  },
  proxyAdditionalSecureLinks: {
    status: 'proxy_additional_secure_links.status',
    upstreamKind: 'proxy_additional_secure_links.upstream_kind',
    dockerNodeId: 'proxy_additional_secure_links.docker_node_id',
    dockerContainerName: 'proxy_additional_secure_links.docker_container_name',
    targetContainer: 'proxy_additional_secure_links.target_container',
    generation: 'proxy_additional_secure_links.generation',
  },
  proxyAdditionalRoutes: {
    targetKind: 'proxy_additional_routes.target_kind',
    dockerNodeId: 'proxy_additional_routes.docker_node_id',
    dockerContainerName: 'proxy_additional_routes.docker_container_name',
  },
}));

const HOST_ID = '44444444-4444-4444-8444-444444444444';

describe('ProxyService renders the status page system host with the stale cache', () => {
  it('flags only the status page system host', async () => {
    const renderForHost = vi.fn().mockResolvedValue('rendered');
    const service = new ProxyService({} as any, { renderForHost } as any, {} as any, {} as any, {} as any, {} as any);
    const host = {
      id: HOST_ID,
      type: 'proxy',
      domainNames: ['status.example.com'],
      enabled: true,
      upstreamKind: 'manual',
      forwardHost: '10.0.0.5',
      forwardPort: 3000,
      forwardScheme: 'http',
      secureLinkGeneration: 0,
      secureLinkMigratedAt: null,
      sslEnabled: false,
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
      rawConfig: null,
      rawConfigEnabled: false,
      templateVariables: {},
      nginxTemplateId: null,
      maintenanceEnabled: false,
      isSystem: true,
      systemKind: 'status_page',
    };
    await (service as any).buildNginxConfig(host, {}, null);
    await (service as any).buildNginxConfig({ ...host, isSystem: false, systemKind: null }, {}, null);
    expect(renderForHost.mock.calls[0]![0]).toMatchObject({ statusPageStaleCache: true });
    expect(renderForHost.mock.calls[1]![0]).toMatchObject({ statusPageStaleCache: false });
  });
});
