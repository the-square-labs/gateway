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
import { CryptoService } from '@/services/crypto.service.js';
import type { AppEnv } from '@/types.js';
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

export const caRoutes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

caRoutes.use('*', authMiddleware);
caRoutes.use('*', requireGatewayFeature('pkiEnabled', 'PKI'));

function caTypeScope(prefix: 'pki:ca:view' | 'pki:ca:revoke', type: string) {
  return type === 'root' ? `${prefix}:root` : `${prefix}:intermediate`;
}

// List CAs (tree)
caRoutes.openapi(
  {
    ...listCAsRoute,
    middleware: requireAnyScopeBase('pki:ca:view:root', 'pki:ca:view:intermediate', 'pki:cert:issue'),
  },
  async (c) => {
    const caService = container.resolve(CAService);
    const showSystem = c.req.query('showSystem') === 'true';
    const scopes = c.get('effectiveScopes') || [];
    if (showSystem && !hasScope(scopes, 'admin:details:certificates')) {
      return c.json({ code: 'FORBIDDEN', message: 'Insufficient permissions' }, 403);
    }
    const tree = await caService.getCATree(showSystem);
    const issuableCAIds = new Set(getResourceScopedIds(scopes, 'pki:cert:issue'));
    return c.json(
      tree.filter(
        (ca) =>
          (ca.type === 'root' && hasScope(scopes, 'pki:ca:view:root')) ||
          (ca.type === 'intermediate' && hasScope(scopes, 'pki:ca:view:intermediate')) ||
          issuableCAIds.has(ca.id)
      )
    );
  }
);

// Get CA detail
caRoutes.openapi(
  { ...getCARoute, middleware: requireAnyScope('pki:ca:view:root', 'pki:ca:view:intermediate') },
  async (c) => {
    const caService = container.resolve(CAService);
    const scopes = c.get('effectiveScopes') || [];
    const id = c.req.param('id')!;
    const ca = await caService.getCA(id, {
      includeSystem: hasScope(scopes, 'admin:details:certificates'),
    });
    const requiredScope = caTypeScope('pki:ca:view', ca.type);
    if (!hasScope(scopes, requiredScope)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`);
    }
    return c.json(ca);
  }
);

// Create root CA (admin only)
caRoutes.openapi({ ...createRootCARoute, middleware: requireScope('pki:ca:create:root') }, async (c) => {
  const caService = container.resolve(CAService);
  const user = c.get('user')!;
  const body = await c.req.json();
  const input = CreateRootCASchema.parse(body);
  const ca = await caService.createRootCA(input, user.id);
  return c.json(ca, 201);
});

// Create intermediate CA (admin only)
caRoutes.openapi(
  { ...createIntermediateCARoute, middleware: requireScopeForResource('pki:ca:create:intermediate', 'id') },
  async (c) => {
    const caService = container.resolve(CAService);
    const user = c.get('user')!;
    const parentId = c.req.param('id')!;
    const body = await c.req.json();
    const input = CreateIntermediateCASchema.parse(body);
    const ca = await caService.createIntermediateCA(parentId, input, user.id);
    return c.json(ca, 201);
  }
);

// Update CA settings (admin only)
caRoutes.openapi({ ...updateCARoute, middleware: requireScope('pki:ca:create:root') }, async (c) => {
  const caService = container.resolve(CAService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const input = UpdateCASchema.parse(body);
  const ca = await caService.updateCA(id, input, user.id);
  return c.json(ca);
});

// Revoke CA (admin only)
caRoutes.openapi(
  { ...revokeCARoute, middleware: requireAnyScope('pki:ca:revoke:root', 'pki:ca:revoke:intermediate') },
  async (c) => {
    const caService = container.resolve(CAService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const body = await c.req.json();
    const { reason } = RevokeCASchema.parse(body);
    const ca = await caService.getCA(id, {
      includeSystem: hasScope(c.get('effectiveScopes') || [], 'admin:details:certificates'),
    });
    const requiredScope = caTypeScope('pki:ca:revoke', ca.type);
    if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`);
    }
    await caService.revokeCA(id, reason, user.id);
    return c.json({ message: 'CA revoked' });
  }
);

// Delete CA (admin only)
caRoutes.openapi(
  { ...deleteCARoute, middleware: requireAnyScope('pki:ca:revoke:root', 'pki:ca:revoke:intermediate') },
  async (c) => {
    const caService = container.resolve(CAService);
    const user = c.get('user')!;
    const id = c.req.param('id')!;
    const ca = await caService.getCA(id, {
      includeSystem: hasScope(c.get('effectiveScopes') || [], 'admin:details:certificates'),
    });
    const requiredScope = caTypeScope('pki:ca:revoke', ca.type);
    if (!hasScope(c.get('effectiveScopes') || [], requiredScope)) {
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: ${requiredScope}`);
    }
    await caService.deleteCA(id, user.id);
    return c.body(null, 204);
  }
);

// Export CA private key (admin only)
caRoutes.openapi({ ...exportCAKeyRoute, middleware: requireScope('pki:ca:create:root') }, async (c) => {
  const caService = container.resolve(CAService);
  const _cryptoService = container.resolve(CryptoService);
  const exportService = container.resolve(ExportService);
  const auditService = container.resolve(AuditService);
  const user = c.get('user')!;
  const id = c.req.param('id')!;
  const body = await c.req.json();
  const { passphrase } = ExportCAKeySchema.parse(body);

  const { ca, privateKeyPem } = await caService.getCASigningMaterials(id);
  const p12 = exportService.exportCAKey(privateKeyPem, ca.certificatePem, passphrase);

  await auditService.log({
    userId: user.id,
    action: 'ca.export_key',
    resourceType: 'ca',
    resourceId: id,
    userAgent: c.req.header('user-agent'),
  });

  return new Response(p12, {
    headers: {
      'Content-Type': 'application/x-pkcs12',
      'Content-Disposition': `attachment; filename="${sanitizeFilename(ca.commonName)}.p12"`,
    },
  });
});

// Generate OCSP responder cert (admin only)
caRoutes.openapi({ ...createOCSPResponderRoute, middleware: requireScope('pki:ca:create:root') }, async (c) => {
  return c.json({ code: 'OCSP_DISABLED', message: 'OCSP responder is currently disabled' }, 501);
});
