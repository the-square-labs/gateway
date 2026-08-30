import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv, User } from '@/types.js';
import { inferenceSetupAuthMiddleware } from './inference-setup-auth.middleware.js';
import { InferenceTokenService } from './inference-token.service.js';

vi.mock('@/config/env.js', () => ({
  getDeploymentMode: () => 'demo',
}));

const DEMO_USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: null,
  authMethod: 'demo_email_otp',
  email: 'visitor@example.test',
  name: 'Visitor',
  avatarUrl: null,
  groupId: 'demo-admin-id',
  groupName: 'demo-admin',
  scopes: ['inference:setup'],
  isBlocked: false,
};

afterEach(() => container.reset());

describe('inference setup demo isolation', () => {
  it('denies a pre-existing inference token before the setup handler runs', async () => {
    container.registerInstance(InferenceTokenService, {
      validateToken: vi.fn().mockResolvedValue({ user: DEMO_USER, managedBy: null }),
    } as never);
    const handler = vi.fn();
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.use('*', inferenceSetupAuthMiddleware);
    app.post('/api/inference/setup/tokens', async (c) => {
      await handler();
      return c.json({ ok: true });
    });

    const response = await app.request('/api/inference/setup/tokens', {
      method: 'POST',
      headers: { Authorization: 'Bearer gwi_existing' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'DEMO_MODE_RESTRICTED' });
    expect(handler).not.toHaveBeenCalled();
  });
});
