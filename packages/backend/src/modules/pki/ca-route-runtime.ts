import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireGatewayFeature } from '@/middleware/feature-flags.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import {
  authMiddleware,
  requireAnyScope,
  requireAnyScopeBase,
  requireScope,
  requireScopeForResource,
} from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import { CryptoService } from '@/services/crypto.service.js';
import {
  createIntermediateCARoute,
  createOCSPResponderRoute,
  createRootCARoute,
  deleteCARoute,
  exportCAKeyRoute,
  getCARoute,
  listCAsRoute,
  revokeCARoute,
  updateCARoute,
} from './ca.docs.js';
import {
  CreateIntermediateCASchema,
  CreateRootCASchema,
  ExportCAKeySchema,
  RevokeCASchema,
  UpdateCASchema,
} from './ca.schemas.js';
import { CAService } from './ca.service.js';
import { ExportService } from './export.service.js';
export const caRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  getResourceScopedIds,
  hasScope,
  sanitizeFilename,
  AppError,
  requireGatewayFeature,
  AuditService,
  authMiddleware,
  requireAnyScope,
  requireAnyScopeBase,
  requireScope,
  requireScopeForResource,
  requireLicenseFeature,
  CryptoService,
  createIntermediateCARoute,
  createOCSPResponderRoute,
  createRootCARoute,
  deleteCARoute,
  exportCAKeyRoute,
  getCARoute,
  listCAsRoute,
  revokeCARoute,
  updateCARoute,
  CreateIntermediateCASchema,
  CreateRootCASchema,
  ExportCAKeySchema,
  RevokeCASchema,
  UpdateCASchema,
  CAService,
  ExportService,
};
