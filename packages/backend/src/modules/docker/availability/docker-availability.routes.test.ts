import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';
import { registerDockerAvailabilityRoutes } from './docker-availability.routes.js';
import { DockerAvailabilityPolicyInputSchema } from './docker-availability.schemas.js';
import { DockerAvailabilityService } from './docker-availability.service.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const PLACEMENT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';

function input() {
  return {
    resource: { type: 'container' as const, nodeId: NODE_ID, containerName: 'api' },
    mode: 'replicated' as const,
    desiredReplicaCount: 2,
    nodeSelectionMode: 'selected' as const,
    selectedNodeIds: [NODE_ID],
    rolloutPolicy: { maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 },
    offlineReplacementGraceSeconds: 15,
  };
}

function appWithScopes(scopes: string[]) {
  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: USER_ID, scopes } as never);
    await next();
  });
  registerDockerAvailabilityRoutes(app);
  return app;
}

afterEach(() => container.reset());

describe('Docker Availability schemas', () => {
  it('applies the rollout and offline replacement defaults', () => {
    expect(
      DockerAvailabilityPolicyInputSchema.parse({
        resource: { type: 'deployment', deploymentId: POLICY_ID },
        mode: 'failover',
        desiredReplicaCount: 1,
        nodeSelectionMode: 'all_compatible',
      })
    ).toMatchObject({
      rolloutPolicy: { maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 },
      offlineReplacementGraceSeconds: 15,
      selectedNodeIds: [],
    });
  });

  it('enforces mode and selected-node invariants', () => {
    expect(() =>
      DockerAvailabilityPolicyInputSchema.parse({
        ...input(),
        mode: 'failover',
        desiredReplicaCount: 2,
      })
    ).toThrow();
    expect(() =>
      DockerAvailabilityPolicyInputSchema.parse({
        ...input(),
        selectedNodeIds: [NODE_ID, NODE_ID],
      })
    ).toThrow();
    expect(() =>
      DockerAvailabilityPolicyInputSchema.parse({
        ...input(),
        nodeSelectionMode: 'selected',
        selectedNodeIds: [],
      })
    ).toThrow();
  });
});

describe('Docker Availability routes', () => {
  it('delegates the typed preflight and resource lookup to the service with effective scopes', async () => {
    const service = {
      preflight: vi.fn().mockResolvedValue({ eligible: true }),
      getByResource: vi.fn().mockResolvedValue(null),
    };
    container.registerInstance(DockerAvailabilityService, service as never);
    const scopes = ['docker:containers:view', 'docker:availability:manage'];
    const app = appWithScopes(scopes);

    const preflightResponse = await app.request('/availability/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    expect(preflightResponse.status).toBe(200);
    expect(service.preflight).toHaveBeenCalledWith(input(), scopes);

    const lookupResponse = await app.request(
      `/availability/by-resource?type=container&nodeId=${NODE_ID}&containerName=api`
    );
    expect(lookupResponse.status).toBe(200);
    expect(service.getByResource).toHaveBeenCalledWith(
      { type: 'container', nodeId: NODE_ID, containerName: 'api' },
      scopes
    );
  });

  it('uses the composed manage middleware for mutations and forwards every service argument', async () => {
    const service = {
      enable: vi.fn().mockResolvedValue({ id: POLICY_ID }),
      update: vi.fn().mockResolvedValue({ id: POLICY_ID }),
      disable: vi.fn().mockResolvedValue({ id: POLICY_ID }),
      retryOperation: vi.fn().mockResolvedValue({ id: OPERATION_ID }),
    };
    container.registerInstance(DockerAvailabilityService, service as never);
    const scopes = ['docker:availability:manage'];
    const app = appWithScopes(scopes);

    const enableResponse = await app.request('/availability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });
    expect(enableResponse.status).toBe(202);
    expect(service.enable).toHaveBeenCalledWith(input(), USER_ID, scopes);

    const update = { mode: 'failover', desiredReplicaCount: 1 };
    const updateResponse = await app.request(`/availability/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update),
    });
    expect(updateResponse.status).toBe(202);
    expect(service.update).toHaveBeenCalledWith(POLICY_ID, update, USER_ID, scopes);

    const disable = { survivingPlacementId: PLACEMENT_ID, confirmation: 'api' };
    const disableResponse = await app.request(`/availability/${POLICY_ID}/disable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(disable),
    });
    expect(disableResponse.status).toBe(202);
    expect(service.disable).toHaveBeenCalledWith(POLICY_ID, disable, USER_ID, scopes);

    const retryResponse = await app.request(`/availability/${POLICY_ID}/operations/${OPERATION_ID}/retry`, {
      method: 'POST',
    });
    expect(retryResponse.status).toBe(202);
    expect(service.retryOperation).toHaveBeenCalledWith(POLICY_ID, OPERATION_ID, USER_ID, scopes);
  });

  it('keeps policy and operation reads delegated to the service', async () => {
    const service = {
      get: vi.fn().mockResolvedValue({ id: POLICY_ID }),
      listOperations: vi.fn().mockResolvedValue([]),
    };
    container.registerInstance(DockerAvailabilityService, service as never);
    const scopes = ['docker:containers:view'];
    const app = appWithScopes(scopes);

    const policyResponse = await app.request(`/availability/${POLICY_ID}`);
    expect(policyResponse.status).toBe(200);
    expect(service.get).toHaveBeenCalledWith(POLICY_ID, scopes);

    const operationsResponse = await app.request(`/availability/${POLICY_ID}/operations`);
    expect(operationsResponse.status).toBe(200);
    expect(service.listOperations).toHaveBeenCalledWith(POLICY_ID, scopes);
  });

  it('rejects a mutation before service work without the availability manage scope', async () => {
    const service = { enable: vi.fn() };
    container.registerInstance(DockerAvailabilityService, service as never);
    const response = await appWithScopes([]).request('/availability', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input()),
    });

    expect(response.status).toBe(403);
    expect(service.enable).not.toHaveBeenCalled();
  });
});
