import { describe, expect, it, vi } from 'vitest';
import { assertProxyReferenceAccess } from './proxy-reference-access.js';

function dbReturning(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return { select: vi.fn(() => chain) } as any;
}

const CERT_ID = '11111111-1111-4111-8111-111111111111';
const activeServerCert = {
  id: CERT_ID,
  status: 'active',
  type: 'tls-server',
  notAfter: new Date(Date.now() + 86_400_000),
  hasPrivateKey: 'encrypted',
  caIsSystem: false,
};

describe('proxy route reference access', () => {
  it('requires view access to a newly referenced SSL certificate, access list and template', async () => {
    const db = dbReturning([{ id: 'x' }]);
    await expect(assertProxyReferenceAccess(db, ['proxy:edit'], { sslCertificateId: 'cert-1' })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredScope: 'ssl:cert:view:cert-1' },
    });
    await expect(assertProxyReferenceAccess(db, ['proxy:edit'], { accessListId: 'acl-1' })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredScope: 'acl:view:acl-1' },
    });
    await expect(assertProxyReferenceAccess(db, ['proxy:edit'], { nginxTemplateId: 'tpl-1' })).rejects.toMatchObject({
      statusCode: 403,
      details: { requiredScope: 'proxy:templates:view:tpl-1' },
    });
    await expect(
      assertProxyReferenceAccess(db, ['ssl:cert:view:cert-1', 'acl:view', 'proxy:templates:view:tpl-1'], {
        sslCertificateId: 'cert-1',
        accessListId: 'acl-1',
        nginxTemplateId: 'tpl-1',
      })
    ).resolves.toBeUndefined();
  });

  it('skips unchanged and cleared references', async () => {
    const db = dbReturning([]);
    await expect(
      assertProxyReferenceAccess(
        db,
        [],
        { sslCertificateId: 'cert-1', accessListId: null, internalCertificateId: CERT_ID },
        { sslCertificateId: 'cert-1', accessListId: 'acl-1', internalCertificateId: CERT_ID }
      )
    ).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('requires the PKI export scope before deploying an internal certificate key', async () => {
    await expect(
      assertProxyReferenceAccess(dbReturning([activeServerCert]), ['pki:cert:view'], {
        internalCertificateId: CERT_ID,
      })
    ).rejects.toMatchObject({ statusCode: 403, details: { requiredScope: `pki:cert:export:${CERT_ID}` } });
    await expect(
      assertProxyReferenceAccess(dbReturning([activeServerCert]), [`pki:cert:export:${CERT_ID}`], {
        internalCertificateId: CERT_ID,
      })
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a system CA leaf', { caIsSystem: true }],
    ['a client certificate', { type: 'tls-client' }],
    ['a revoked certificate', { status: 'revoked' }],
    ['an expired certificate', { notAfter: new Date(Date.now() - 1000) }],
    ['a certificate without a managed key', { hasPrivateKey: null }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      assertProxyReferenceAccess(dbReturning([{ ...activeServerCert, ...overrides }]), ['pki:cert:export'], {
        internalCertificateId: CERT_ID,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INTERNAL_CERTIFICATE_NOT_ALLOWED' });
  });

  it('rejects references to missing resources', async () => {
    await expect(
      assertProxyReferenceAccess(dbReturning([]), ['acl:view'], { accessListId: 'missing' })
    ).rejects.toMatchObject({ statusCode: 400, code: 'ACCESS_LIST_NOT_FOUND' });
  });
});
