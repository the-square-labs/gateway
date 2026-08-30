import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';

let deploymentMode: 'standard' | 'demo' = 'standard';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ GATEWAY_DEPLOYMENT_MODE: deploymentMode }),
  getDeploymentMode: () => deploymentMode,
}));

const { DEMO_MODE_RESTRICTED, assertDemoRequestAllowed, isDemoRealtimeCapabilityAllowed } = await import(
  './demo-mode.js'
);

const demoUser = {
  id: 'demo-user',
  oidcSubject: null,
  authMethod: 'demo_email_otp',
  email: 'visitor@example.test',
  name: 'visitor@example.test',
  avatarUrl: null,
  groupId: 'demo-admin-id',
  groupName: 'demo-admin',
  scopes: ['docker:containers:create'],
  isBlocked: false,
} satisfies User;

function context(input: { method: string; path: string; user?: User; scopes?: string[] }) {
  const values = new Map<string, unknown>([
    ['user', input.user ?? demoUser],
    ['effectiveScopes', input.scopes ?? input.user?.scopes ?? demoUser.scopes],
  ]);
  return {
    req: { method: input.method, url: `https://gateway.example.test${input.path}` },
    get: (key: string) => values.get(key),
  } as never;
}

describe('DemoModePolicy', () => {
  beforeEach(() => {
    deploymentMode = 'standard';
  });

  it('is completely inert in standard mode', () => {
    expect(() =>
      assertDemoRequestAllowed(context({ method: 'DELETE', path: '/api/nodes/critical', user: undefined, scopes: [] }))
    ).not.toThrow();
  });

  it('denies unsafe methods for demo visitors', () => {
    deploymentMode = 'demo';
    expect(() => assertDemoRequestAllowed(context({ method: 'POST', path: '/api/docker/containers' }))).toThrowError(
      expect.objectContaining({ code: DEMO_MODE_RESTRICTED, statusCode: 403 })
    );
  });

  it('allows ordinary reads and a narrow read-only POST allowlist', () => {
    deploymentMode = 'demo';
    expect(() => assertDemoRequestAllowed(context({ method: 'GET', path: '/api/docker/containers' }))).not.toThrow();
    expect(() =>
      assertDemoRequestAllowed(context({ method: 'POST', path: '/api/monitoring/dashboard/bootstrap' }))
    ).not.toThrow();
  });

  it('denies sensitive reads, exec, files, tokens, AI, MCP, OAuth, and SQL', () => {
    deploymentMode = 'demo';
    const paths = [
      '/api/nodes/node-1/files',
      '/api/docker/nodes/node-1/containers/container-1/exec',
      '/api/databases/db-1/query',
      '/api/databases/db-1/reveal-credentials',
      '/api/tokens',
      '/api/ai/config',
      '/api/mcp',
      '/api/oauth/authorizations',
      '/api/inference/providers',
      '/api/notifications/webhooks',
      '/api/logging/environments/env-1/tokens',
      '/api/docker/registry/token',
      '/api/audit',
      '/api/admin/users/11111111-1111-4111-8111-111111111111/sessions',
      '/api/nodes/node-1/config',
      '/api/docker/nodes/node-1/containers/container-1/env',
    ];
    for (const path of paths) {
      expect(() => assertDemoRequestAllowed(context({ method: 'GET', path })), path).toThrowError(
        expect.objectContaining({ code: DEMO_MODE_RESTRICTED })
      );
    }
  });

  it('requires both canonical group identity and admin:system for bypass', () => {
    deploymentMode = 'demo';
    const base = { ...demoUser, id: 'admin', groupId: 'system-admin-id', groupName: 'system-admin' };
    expect(() =>
      assertDemoRequestAllowed(context({ method: 'POST', path: '/api/system/update', user: base, scopes: [] }))
    ).toThrowError(expect.objectContaining({ code: DEMO_MODE_RESTRICTED }));
    expect(() =>
      assertDemoRequestAllowed(
        context({
          method: 'POST',
          path: '/api/system/update',
          user: { ...base, groupName: 'custom-admin' },
          scopes: ['admin:system'],
        })
      )
    ).toThrowError(expect.objectContaining({ code: DEMO_MODE_RESTRICTED }));
    expect(() =>
      assertDemoRequestAllowed(
        context({ method: 'POST', path: '/api/system/update', user: base, scopes: ['admin:system'] })
      )
    ).not.toThrow();
  });

  it('fails closed for console and AI realtime channels even if a demo identity gains their scopes', () => {
    deploymentMode = 'demo';
    expect(isDemoRealtimeCapabilityAllowed(demoUser, ['nodes:console'], 'nodes:console:node-1')).toBe(false);
    expect(isDemoRealtimeCapabilityAllowed(demoUser, ['ai:workspace:use'], 'ai:workspace')).toBe(false);
    expect(isDemoRealtimeCapabilityAllowed(demoUser, ['nodes:logs'], 'nodes:logs:node-1')).toBe(true);

    const systemAdmin = { ...demoUser, groupName: 'system-admin' };
    expect(isDemoRealtimeCapabilityAllowed(systemAdmin, ['admin:system'], 'ai:workspace')).toBe(true);
    expect(isDemoRealtimeCapabilityAllowed(systemAdmin, ['admin:system'], 'nodes:console:node-1')).toBe(true);
  });

  it('allows logout but no other authenticated POST by default', () => {
    deploymentMode = 'demo';
    expect(() => assertDemoRequestAllowed(context({ method: 'POST', path: '/auth/logout' }))).not.toThrow();
    expect(() => assertDemoRequestAllowed(context({ method: 'POST', path: '/auth/me/preferences' }))).toThrowError(
      expect.objectContaining({ code: DEMO_MODE_RESTRICTED })
    );
  });
});
