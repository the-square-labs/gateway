import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import type { AppEnv } from '@/types.js';
import {
  ActivateLicenseSchema,
  activateLicenseRoute,
  checkLicenseRoute,
  clearLicenseRoute,
  licenseStatusRoute,
} from './license.docs.js';
import { toLicenseAppError } from './license.errors.js';
import { LicenseService } from './license.service.js';

export const licenseRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

licenseRoutes.use('*', authMiddleware);

licenseRoutes.openapi({ ...licenseStatusRoute, middleware: requireScope('license:view') }, async (c) => {
  const service = container.resolve(LicenseService);
  return c.json({ data: await service.getStatus() });
});

licenseRoutes.openapi({ ...activateLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const body = ActivateLicenseSchema.parse(await c.req.json());
  const service = container.resolve(LicenseService);
  try {
    return c.json({ data: await service.activateKey(body.licenseKey) });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

licenseRoutes.openapi({ ...checkLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const service = container.resolve(LicenseService);
  try {
    return c.json({ data: await service.checkNow() });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});

licenseRoutes.openapi({ ...clearLicenseRoute, middleware: requireScope('license:manage') }, async (c) => {
  const service = container.resolve(LicenseService);
  try {
    return c.json({ data: await service.clearKey() });
  } catch (error) {
    throw toLicenseAppError(error) ?? error;
  }
});
