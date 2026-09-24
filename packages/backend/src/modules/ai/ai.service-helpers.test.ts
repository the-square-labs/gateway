import { describe, expect, it } from 'vitest';
import { redactArgsForTool } from './ai.service.tool-helpers.js';
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

  it('redacts connection strings and credentials embedded in URL arguments', () => {
    expect(
      redactToolArgs({
        passphrase: 'p12-passphrase',
        config: {
          connectionString: 'postgres://app:db-pass@db.internal:5432/app',
          connectionUri: 'mongodb://app:db-pass@mongo.internal/app',
          endpoint: 'db.internal',
        },
        repositoryUrl: 'https://oauth2:glpat-secret@gitlab.example.com/group/app.git',
        baseUrl: 'https://api.example.com/v1?api_key=raw-key&region=eu',
        url: 'https://hooks.example.com/notify?code=oauth-code&sig=raw-sig',
        docsUrl: 'https://docs.example.com/guide?page=2',
      })
    ).toEqual({
      passphrase: '[REDACTED]',
      config: {
        connectionString: '[REDACTED]',
        connectionUri: '[REDACTED]',
        endpoint: 'db.internal',
      },
      repositoryUrl: 'https://REDACTED@gitlab.example.com/group/app.git',
      baseUrl: 'https://api.example.com/v1?api_key=REDACTED&region=eu',
      url: 'https://hooks.example.com/notify?code=REDACTED&sig=REDACTED',
      docsUrl: 'https://docs.example.com/guide?page=2',
    });
  });

  it('redacts per-tool secret values, webhook targets and OAuth callbacks', () => {
    expect(
      redactArgsForTool('github_upsert_actions_secret', {
        connectorId: 'connector-1',
        repositoryUrl: 'https://github.com/acme/app',
        name: 'DEPLOY_KEY',
        value: 'raw-actions-secret',
      })
    ).toEqual({
      connectorId: 'connector-1',
      repositoryUrl: 'https://github.com/acme/app',
      name: 'DEPLOY_KEY',
      value: '[REDACTED]',
    });
    expect(
      redactArgsForTool('update_webhook', {
        webhookId: 'webhook-1',
        url: 'https://api.telegram.org/bot123:raw-bot-token/sendMessage',
        headers: { 'X-Custom': 'raw-header-secret', Authorization: 'Bearer raw-token' },
        signingSecret: 'raw-signing-secret',
        enabled: true,
      })
    ).toEqual({
      webhookId: 'webhook-1',
      url: 'https://api.telegram.org/********',
      headers: { 'X-Custom': '********', Authorization: '********' },
      signingSecret: '[REDACTED]',
      enabled: true,
    });
    expect(redactArgsForTool('create_webhook', { name: 'Hook', url: 'not a url' })).toEqual({
      name: 'Hook',
      url: '********',
    });
    expect(
      redactArgsForTool('manage_inference_provider', {
        operation: 'complete_authorization',
        sessionId: 'session-1',
        callback: 'http://localhost:1455/auth/callback?code=raw-oauth-code&state=abc',
      })
    ).toEqual({ operation: 'complete_authorization', sessionId: 'session-1', callback: '[REDACTED]' });
  });

  it('binds create_route authorization to the target node', () => {
    expect(getToolAuthorizationResourceId('create_route', { nodeId: 'node-1' })).toBe('node-1');
    expect(getToolAuthorizationResourceId('update_route', { routeId: 'host-1' })).toBe('host-1');
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
