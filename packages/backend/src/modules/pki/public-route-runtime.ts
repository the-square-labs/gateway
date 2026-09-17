import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { requireLicenseFeatureForExistingRuntime } from '@/modules/license/license-policy.middleware.js';
import { CAService } from './ca.service.js';
import { CRLService } from './crl.service.js';
import { publicCaCertificateRoute, publicCrlRoute, publicOcspGetRoute, publicOcspPostRoute } from './public.docs.js';
export const publicPkiRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  sanitizeFilename,
  requireLicenseFeatureForExistingRuntime,
  CAService,
  CRLService,
  publicCaCertificateRoute,
  publicCrlRoute,
  publicOcspGetRoute,
  publicOcspPostRoute,
};
