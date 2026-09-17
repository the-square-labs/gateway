import { OpenAPIHono } from '@hono/zod-openapi';
import { container } from '@/container.js';
import { openApiValidationHook } from '@/lib/openapi.js';
import { getResourceScopedIds, hasScope, hasScopeForResource } from '@/lib/permissions.js';
import { sanitizeFilename } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import { requireGatewayFeature } from '@/middleware/feature-flags.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { authMiddleware, requireScopeBase, requireScopeForResource } from '@/modules/auth/auth.middleware.js';
import { requireLicenseFeature } from '@/modules/license/license-policy.middleware.js';
import { CAService } from './ca.service.js';
import {
  certificateChainRoute,
  exportCertificateRoute,
  getCertificateRoute,
  issueCertificateFromCSRRoute,
  issueCertificateRoute,
  listCertificatesRoute,
  revokeCertificateRoute,
} from './cert.docs.js';
import {
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
} from './cert.schemas.js';
import { CertService } from './cert.service.js';
import { CRLService } from './crl.service.js';
import { ExportService } from './export.service.js';
import { OCSPService } from './ocsp.service.js';
export const certRouteRuntime = {
  OpenAPIHono,
  container,
  openApiValidationHook,
  getResourceScopedIds,
  hasScope,
  hasScopeForResource,
  sanitizeFilename,
  AppError,
  requireGatewayFeature,
  AuditService,
  authMiddleware,
  requireScopeBase,
  requireScopeForResource,
  requireLicenseFeature,
  CAService,
  certificateChainRoute,
  exportCertificateRoute,
  getCertificateRoute,
  issueCertificateFromCSRRoute,
  issueCertificateRoute,
  listCertificatesRoute,
  revokeCertificateRoute,
  CertificateListQuerySchema,
  ExportCertificateQuerySchema,
  IssueCertFromCSRSchema,
  IssueCertificateSchema,
  RevokeCertificateSchema,
  CertService,
  CRLService,
  ExportService,
  OCSPService,
};
