import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { requireGatewayFeature } from '@/middleware/feature-flags.js';
import { authMiddleware, requireScope } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import {
  createTemplateRoute,
  deleteTemplateRoute,
  getTemplateRoute,
  listTemplatesRoute,
  updateTemplateRoute,
} from './templates.docs.js';
import { CreateTemplateSchema, UpdateTemplateSchema } from './templates.schemas.js';
import { TemplatesService } from './templates.service.js';
export const templateRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  requireGatewayFeature,
  authMiddleware,
  requireScope,
  requireLicenseFeature,
  createTemplateRoute,
  deleteTemplateRoute,
  getTemplateRoute,
  listTemplatesRoute,
  updateTemplateRoute,
  CreateTemplateSchema,
  UpdateTemplateSchema,
  TemplatesService,
};
