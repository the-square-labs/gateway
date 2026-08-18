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
import type { AppEnv } from '@/types.js';
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

export const certRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

certRoutes.use('*', authMiddleware);
certRoutes.use('*', requireGatewayFeature('pkiEnabled', 'PKI'));
certRoutes.use('*', requireLicenseFeature('internal-pki'));

// List certificates (paginated, filterable)
certRoutes.openapi({ ...listCertificatesRoute, middleware: requireScopeBase('pki:cert:view') }, async (c) => {
  const certService = container.resolve(CertService);
  const query = CertificateListQuerySchema.parse({
    caId: c.req.query('caId'),
    status: c.req.query('status'),
    type: c.req.query('type'),
    search: c.req.query('search'),
    showSystem: c.req.query('showSystem'),
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    sortBy: c.req.query('sortBy'),
    sortOrder: c.req.query('sortOrder'),
  });
  const scopes = c.get('effectiveScopes') || [];
  if (query.showSystem && !hasScope(scopes, 'admin:details:certificates')) {
    return c.json({ code: 'FORBIDDEN', message: 'Insufficient permissions' }, 403);
  }
  const result = await certService.listCertificates(
    query,
    hasScope(scopes, 'pki:cert:view') ? undefined : { allowedIds: getResourceScopedIds(scopes, 'pki:cert:view') }
  );
  return c.json(result);
});

// Get certificate detail
certRoutes.openapi(
  { ...getCertificateRoute, middleware: requireScopeForResource('pki:cert:view', 'id') },
  async (c) => {
    const certService = container.resolve(CertService);
    const scopes = c.get('effectiveScopes') || [];
    const id = c.req.param('id')!;
    const cert = await certService.getCertificate(id, {
      includeSystem: hasScope(scopes, 'admin:details:certificates'),
    });
    return c.json(cert);
  }
);

// Issue certificate (server-side key generation)
certRoutes.openapi({ ...issueCertificateRoute, middleware: requireScopeBase('pki:cert:issue') }, async (c) => {
  const certService = container.resolve(CertService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = IssueCertificateSchema.parse(body);
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScopeForResource(scopes, 'pki:cert:issue', input.caId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: pki:cert:issue:${input.caId}`);
  }
  const result = await certService.issueCertificate(input, user.id);
  return c.json(result, 201);
});

// Issue certificate from CSR
certRoutes.openapi({ ...issueCertificateFromCSRRoute, middleware: requireScopeBase('pki:cert:issue') }, async (c) => {
  const certService = container.resolve(CertService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = IssueCertFromCSRSchema.parse(body);
  const scopes = c.get('effectiveScopes') || [];
  if (!hasScopeForResource(scopes, 'pki:cert:issue', input.caId)) {
    throw new AppError(403, 'FORBIDDEN', `Missing required scope: pki:cert:issue:${input.caId}`);
  }
  const cert = await certService.issueCertificateFromCSR(input, user.id);
  return c.json(cert, 201);
});

// Revoke certificate
certRoutes.openapi(
  { ...revokeCertificateRoute, middleware: requireScopeForResource('pki:cert:revoke', 'id') },
  async (c) => {
    const certService = container.resolve(CertService);
    const crlService = container.resolve(CRLService);
    const _ocspService = container.resolve(OCSPService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const { reason } = RevokeCertificateSchema.parse(body);

    const caId = await certService.revokeCertificate(id, reason, user.id);

    // Regenerate CRL for the issuing CA
    await crlService.generateCRL(caId);

    return c.json({ message: 'Certificate revoked' });
  }
);

// Export certificate
certRoutes.openapi(
  { ...exportCertificateRoute, middleware: requireScopeForResource('pki:cert:export', 'id') },
  async (c) => {
    const certService = container.resolve(CertService);
    const exportService = container.resolve(ExportService);
    const auditService = container.resolve(AuditService);
    const user = c.get('user')!;
    const scopes = c.get('effectiveScopes') || [];
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const { format, passphrase } = ExportCertificateQuerySchema.parse(body);

    const cert = await certService.getCertificate(id, {
      includeSystem: hasScope(scopes, 'admin:details:certificates'),
    });

    switch (format) {
      case 'pem':
        return new Response(cert.certificatePem, {
          headers: {
            'Content-Type': 'application/x-pem-file',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(cert.commonName)}.pem"`,
          },
        });

      case 'der': {
        const der = exportService.exportDER(cert.certificatePem);
        return new Response(der, {
          headers: {
            'Content-Type': 'application/x-x509-ca-cert',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(cert.commonName)}.der"`,
          },
        });
      }

      case 'pkcs12': {
        if (!passphrase) {
          return c.json({ code: 'PASSPHRASE_REQUIRED', message: 'Passphrase required for PKCS#12 export' }, 400);
        }
        const privateKey = await certService.getCertificatePrivateKey(id);
        if (!privateKey) {
          return c.json({ code: 'NO_PRIVATE_KEY', message: 'Private key not available (CSR-based certificate)' }, 400);
        }
        await auditService.log({
          userId: user.id,
          action: 'cert.export_key',
          resourceType: 'certificate',
          resourceId: id,
          details: { format: 'pkcs12' },
          userAgent: c.req.header('user-agent'),
        });
        const p12 = exportService.exportPKCS12(cert.certificatePem, privateKey, passphrase);
        return new Response(p12, {
          headers: {
            'Content-Type': 'application/x-pkcs12',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(cert.commonName)}.p12"`,
          },
        });
      }

      case 'jks': {
        if (!passphrase) {
          return c.json({ code: 'PASSPHRASE_REQUIRED', message: 'Passphrase required for JKS export' }, 400);
        }
        const jksKey = await certService.getCertificatePrivateKey(id);
        if (jksKey) {
          await auditService.log({
            userId: user.id,
            action: 'cert.export_key',
            resourceType: 'certificate',
            resourceId: id,
            details: { format: 'jks' },
            userAgent: c.req.header('user-agent'),
          });
        }
        const jks = exportService.exportJKS(cert.certificatePem, jksKey, passphrase, cert.commonName);
        return new Response(jks, {
          headers: {
            'Content-Type': 'application/x-java-keystore',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(cert.commonName)}.jks"`,
          },
        });
      }
    }
  }
);

// Download certificate chain
certRoutes.openapi(
  { ...certificateChainRoute, middleware: requireScopeForResource('pki:cert:view', 'id') },
  async (c) => {
    const certService = container.resolve(CertService);
    const caService = container.resolve(CAService);
    const exportService = container.resolve(ExportService);
    const id = c.req.param('id')!;

    const scopes = c.get('effectiveScopes') || [];
    const includeSystem = hasScope(scopes, 'admin:details:certificates');
    const cert = await certService.getCertificate(id, {
      includeSystem,
    });

    // Build chain by walking up the CA hierarchy
    const chainPems: string[] = [];
    let currentCaId: string | null = cert.caId;

    while (currentCaId) {
      const ca = await caService.getCA(currentCaId, { includeSystem });
      chainPems.push(ca.certificatePem);
      currentCaId = ca.parentId;
    }

    const fullChain = exportService.exportPEM(cert.certificatePem, chainPems);

    return new Response(fullChain, {
      headers: {
        'Content-Type': 'application/x-pem-file',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(cert.commonName)}-chain.pem"`,
      },
    });
  }
);
