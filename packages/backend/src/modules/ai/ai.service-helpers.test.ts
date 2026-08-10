import { describe, expect, it } from 'vitest';
import { aiServiceTestHelpers } from './ai.service-helpers.js';

const {
  agentPage,
  agentPageLimit,
  compactAgentList,
  dockerContainerMatchesSearch,
  getToolAuthorizationResourceId,
  hasRegistryHost,
  redactToolArgs,
} = aiServiceTestHelpers;

describe('AI service helpers', () => {
  it('redacts sensitive nested tool arguments while preserving safe values', () => {
    expect(
      redactToolArgs({
        username: 'alice',
        password: 'secret',
        nested: {
          api_key: 'token',
          port: 5432,
        },
        list: [{ clientSecret: 'hidden' }, { name: 'safe' }],
      })
    ).toEqual({
      username: 'alice',
      password: '[REDACTED]',
      nested: {
        api_key: '[REDACTED]',
        port: 5432,
      },
      list: [{ clientSecret: '[REDACTED]' }, { name: 'safe' }],
    });
  });

  it('binds create_proxy_host authorization to the target node', () => {
    expect(getToolAuthorizationResourceId('create_proxy_host', { nodeId: 'node-1' })).toBe('node-1');
    expect(getToolAuthorizationResourceId('update_proxy_host', { proxyHostId: 'host-1' })).toBe('host-1');
  });

  it('normalizes agent pagination to bounded positive integers', () => {
    expect(agentPageLimit('250')).toBe(100);
    expect(agentPageLimit(0)).toBe(1);
    expect(agentPageLimit('bad', 25)).toBe(25);
    expect(agentPage('2000')).toBe(1000);
    expect(agentPage(-10)).toBe(1);
  });

  it('compacts long agent lists with total and truncation metadata', () => {
    const items = Array.from({ length: 1002 }, (_, index) => ({ index }));

    expect(compactAgentList(items)).toEqual({
      data: items.slice(0, 1000),
      total: 1002,
      limit: 1000,
      truncated: true,
    });
  });

  it('matches docker containers across ids, names, images, states, and ports', () => {
    const container = {
      Id: 'container-1',
      Names: ['/ignored'],
      Name: '/gateway-api',
      Image: 'registry.example.com/gateway/api:latest',
      State: 'running',
      Ports: [{ ip: '0.0.0.0', publicPort: 443, privatePort: 8443, type: 'tcp' }],
    };

    expect(dockerContainerMatchesSearch(container, 'gateway-api')).toBe(true);
    expect(dockerContainerMatchesSearch(container, '8443 tcp')).toBe(true);
    expect(dockerContainerMatchesSearch(container, 'missing')).toBe(false);
  });

  it('detects registry hosts in image references without treating namespaces as registries', () => {
    expect(hasRegistryHost('registry.example.com/team/app:tag')).toBe(true);
    expect(hasRegistryHost('localhost/team/app:tag')).toBe(true);
    expect(hasRegistryHost('registry:5000/team/app:tag')).toBe(true);
    expect(hasRegistryHost('team/app:tag')).toBe(false);
  });
});
