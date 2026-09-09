import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { InferenceProtocolError } from '@/modules/inference/protocol/inference-protocol.error.js';
import type { AppEnv } from '@/types.js';
import { AppError, errorHandler } from './error-handler.js';

describe('errorHandler', () => {
  it.each([
    [{ requiredScope: 'hosting:resources:power:vm-1' }, 'Required permission: hosting:resources:power:vm-1'],
    [{ missingScope: 'nodes:details:node-1' }, 'Required permission: nodes:details:node-1'],
    [
      { requiredScopes: ['integrations:git:view', 'integrations:github:view'], scopeMatch: 'any' },
      'Requires any one of these permissions: integrations:git:view, integrations:github:view',
    ],
    [
      { requiredScopes: ['nodes:details', 'nodes:config:edit'], scopeMatch: 'all' },
      'Requires all of these permissions: nodes:details, nodes:config:edit',
    ],
    [
      { missingScopes: ['nodes:details:node-1', 'nodes:config:edit:node-1'] },
      'Requires all of these permissions: nodes:details:node-1, nodes:config:edit:node-1',
    ],
    [
      { requiredScopes: ['nodes:details', 'nodes:config:edit'] },
      'Required permissions: nodes:details, nodes:config:edit',
    ],
    [
      { requiredScopes: ['nodes:details', 'nodes:config:edit'], missingScopes: ['nodes:config:edit'] },
      'Required permission: nodes:config:edit',
    ],
  ])('renders explicit permission diagnostics in both Error.message and the API response (%j)', async (details, suffix) => {
    const error = new AppError(403, 'FORBIDDEN', 'Access denied', details);
    expect(error.message).toBe(`Access denied. ${suffix}`);
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/', () => {
      throw error;
    });
    const response = await app.request('/');
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: 'FORBIDDEN', message: error.message, details });
  });

  it.each([
    undefined,
    null,
    [],
    { requiredScope: 123 },
    { requiredScopes: [] },
    { requiredCapability: 'repoWrite' },
    { resourceId: 'resource-1' },
  ])('does not invent permissions from absent or unrelated details (%j)', (details) => {
    expect(new AppError(403, 'FORBIDDEN', 'Operation is not allowed', details).message).toBe(
      'Operation is not allowed'
    );
  });

  it('does not copy credentials or actor scopes into the message', () => {
    const error = new AppError(403, 'FORBIDDEN', 'Access denied', {
      requiredScope: 'nodes:details',
      token: 'test-secret',
      scopes: ['admin:users'],
      nested: { secret: 'test-secret' },
    });
    expect(error.message).toBe('Access denied. Required permission: nodes:details');
  });

  it('preserves non-403 messages even when scope metadata exists', () => {
    expect(new AppError(400, 'BAD_REQUEST', 'Invalid scope request', { requiredScope: 'nodes:details' }).message).toBe(
      'Invalid scope request'
    );
  });

  it('preserves inference status and code on management routes', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/usage', () => {
      throw new InferenceProtocolError(503, 'budget_policy_unavailable', 'Inference limits are not configured');
    });

    const response = await app.request('/usage');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'budget_policy_unavailable',
      message: 'Inference limits are not configured',
    });
  });
});
