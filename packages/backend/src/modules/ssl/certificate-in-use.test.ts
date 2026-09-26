import { describe, expect, it, vi } from 'vitest';
import { PROXY_HOST_SSL_CERTIFICATE_FK, rethrowCertificateInUse } from './certificate-in-use.js';
import { SSLService } from './ssl.service.js';

/** How node-postgres reports ON DELETE RESTRICT, wrapped the way drizzle wraps driver errors. */
function restrictViolation() {
  const cause = Object.assign(new Error('update or delete on table "ssl_certificates" violates foreign key'), {
    code: '23001',
    constraint: PROXY_HOST_SSL_CERTIFICATE_FK,
  });
  return Object.assign(new Error('Failed query: delete from "ssl_certificates"'), { cause });
}

describe('certificate delete against proxy host references', () => {
  it('maps the restrict violation of a host assigned after the reference check to 409 CERT_IN_USE', async () => {
    const removeAsset = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn((fields?: Record<string, unknown>) => ({
        from: () => ({
          where: () =>
            fields
              ? { limit: async () => [] }
              : { for: async () => [{ id: 'cert-1', name: 'app', domainNames: ['app.example.com'], isSystem: false }] },
        }),
      })),
      // The reference check ran before the host committed its assignment.
      query: { proxyHosts: { findMany: async () => [] } },
      delete: () => ({ where: () => Promise.reject(restrictViolation()) }),
    };
    const db = { transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx) } as any;
    const audit = { log: vi.fn() };
    const service = new SSLService(
      db,
      {} as any,
      {} as any,
      audit as any,
      {
        removeSslCertificateAsset: removeAsset,
      } as any
    );

    await expect(service.deleteCert('cert-1', 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'CERT_IN_USE',
    });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('rethrows every other error unchanged', () => {
    const other = Object.assign(new Error('deadlock'), { code: '40P01' });
    expect(() => rethrowCertificateInUse(other)).toThrow(other);
    const otherConstraint = Object.assign(new Error('fk'), { code: '23001', constraint: 'page_projects_fk' });
    expect(() => rethrowCertificateInUse(otherConstraint)).toThrow(otherConstraint);
  });
});
