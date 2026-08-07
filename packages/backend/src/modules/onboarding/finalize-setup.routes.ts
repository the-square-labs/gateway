import { OpenAPIHono, z } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { authMiddleware, sessionOnly } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  FINALIZE_SETUP_STEPS,
  FinalizeSetupService,
  FinalizeSetupStepConflictError,
  FinalizeSetupUnavailableError,
} from './finalize-setup.service.js';

export const finalizeSetupRoutes = new OpenAPIHono<AppEnv>();

finalizeSetupRoutes.use('*', authMiddleware);
finalizeSetupRoutes.use('*', sessionOnly);

function requireAvailable(error: unknown): never {
  if (error instanceof FinalizeSetupUnavailableError) {
    throw new AppError(404, 'FINALIZE_SETUP_NOT_AVAILABLE', error.message);
  }
  if (error instanceof FinalizeSetupStepConflictError) {
    throw new AppError(409, 'FINALIZE_SETUP_STEP_CONFLICT', error.message);
  }
  throw error;
}

finalizeSetupRoutes.get('/', async (c) => {
  const state = await container.resolve(FinalizeSetupService).getForUser(c.get('user')!.id);
  return c.json({ data: state });
});

finalizeSetupRoutes.get('/mfa-reminder', async (c) => {
  const show = await container.resolve(FinalizeSetupService).shouldShowMfaReminder(c.get('user')!.id);
  return c.json({ data: { show } });
});

finalizeSetupRoutes.post('/mfa-reminder/hide', async (c) => {
  try {
    await container.resolve(FinalizeSetupService).hideMfaReminder(c.get('user')!.id);
    return c.body(null, 204);
  } catch (error) {
    requireAvailable(error);
  }
});

finalizeSetupRoutes.put('/steps/:step', async (c) => {
  const step = z.enum(FINALIZE_SETUP_STEPS).parse(c.req.param('step'));
  const body = z.object({ status: z.enum(['configured', 'skipped']) }).parse(await c.req.json());
  try {
    const state = await container.resolve(FinalizeSetupService).markStep(c.get('user')!.id, step, body.status);
    return c.json({ data: state });
  } catch (error) {
    requireAvailable(error);
  }
});
