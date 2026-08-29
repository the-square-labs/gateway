import 'reflect-metadata';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/error-handler.js';
import type { AppEnv } from '@/types.js';

const mocks = vi.hoisted(() => ({
  scopes: ['pki:cert:export:cert-1'],
  certService: {
    getCertificate: vi.fn(),
    getCertificatePrivateKey: vi.fn(),
  },
  caService: {
    getCA: vi.fn(),
  },
  exportService: {
    exportPEMBundle: vi.fn(),
  },
  auditService: {
    log: vi.fn(),
  },
}));

vi.mock('@/container.js', () => ({
  container: {
    resolve: vi.fn((token) => {
      switch (token?.name) {
        case 'CertService':
          return mocks.certService;
        case 'CAService':
          return mocks.caService;
        case 'ExportService':
          return mocks.exportService;
        case 'AuditService':
          return mocks.auditService;
        default:
          return {};
      }
    }),
  },
}));

vi.mock('@/middleware/feature-flags.js', () => ({
  requireGatewayFeature: () => async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('@/modules/license/license-policy.middleware.js', () => ({
  requireLicenseFeature: () => async (_c: any, next: () => Promise<void>) => next(),
}));

vi.mock('@/modules/auth/auth.middleware.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'user-1' });
    c.set('effectiveScopes', mocks.scopes);
    await next();
  },
  requireScopeBase: () => async (_c: any, next: () => Promise<void>) => next(),
  requireScopeForResource: (base: string, param: string) => async (c: any, next: () => Promise<void>) => {
    const id = c.req.param(param);
    if (!mocks.scopes.includes(base) && !mocks.scopes.includes(`${base}:${id}`)) {
      return c.json({ code: 'FORBIDDEN' }, 403);
    }
    await next();
  },
}));

vi.mock('@/modules/audit/audit.service.js', () => ({ AuditService: class AuditService {} }));
vi.mock('./ca.service.js', () => ({ CAService: class CAService {} }));
vi.mock('./cert.service.js', () => ({ CertService: class CertService {} }));
vi.mock('./crl.service.js', () => ({ CRLService: class CRLService {} }));
vi.mock('./export.service.js', () => ({ ExportService: class ExportService {} }));
vi.mock('./ocsp.service.js', () => ({ OCSPService: class OCSPService {} }));

import { certRoutes } from './cert.routes.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/', certRoutes);
  return app;
}

describe('certificate key exports', () => {
  beforeEach(() => {
    mocks.scopes = ['pki:cert:export:cert-1'];
    vi.clearAllMocks();
    mocks.certService.getCertificate.mockResolvedValue({
      id: 'cert-1',
      caId: 'ca-1',
      commonName: 'example.test',
      certificatePem: 'CERTIFICATE_PEM',
    });
    mocks.certService.getCertificatePrivateKey.mockResolvedValue('PRIVATE_KEY_PEM');
    mocks.caService.getCA.mockResolvedValue({ id: 'ca-1', isSystem: false });
    mocks.auditService.log.mockResolvedValue(true);
    mocks.exportService.exportPEMBundle.mockReturnValue(Buffer.from('zip-content'));
  });

  it('fails closed when a PEM bundle cannot be audited', async () => {
    mocks.auditService.log.mockResolvedValue(false);

    const response = await createApp().request('/cert-1/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'pem-bundle' }),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE_KEY_PEM');
    expect(mocks.exportService.exportPEMBundle).not.toHaveBeenCalled();
  });

  it('accepts only the matching resource-scoped export grant', async () => {
    mocks.scopes = ['pki:cert:export:other-cert'];

    const response = await createApp().request('/cert-1/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'private-key' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.certService.getCertificatePrivateKey).not.toHaveBeenCalled();
  });

  it('does not allow the read-only system certificate scope to export a system private key', async () => {
    mocks.scopes = ['pki:cert:export:cert-1', 'admin:details:certificates'];
    mocks.caService.getCA.mockResolvedValue({ id: 'ca-1', isSystem: true });

    const response = await createApp().request('/cert-1/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'private-key' }),
    });

    expect(response.status).toBe(403);
    expect(mocks.certService.getCertificatePrivateKey).not.toHaveBeenCalled();
  });
});
