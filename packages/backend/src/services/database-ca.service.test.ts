import { describe, expect, it, vi } from 'vitest';
import { DatabaseCAService } from './database-ca.service.js';

function databaseCAService() {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'database-ca-id' }]) })),
      })),
    })),
  };
  const certService = { issueCertificate: vi.fn() };
  const service = new DatabaseCAService(db as any, {} as any, certService as any);
  return { service, certService };
}

describe('DatabaseCAService lifecycle integration', () => {
  it('refuses to issue a system leaf when lifecycle ownership is unavailable', async () => {
    const { service } = databaseCAService();

    await expect(service.issueManagedDatabaseCertificate('database-1', ['203.0.113.15'])).rejects.toThrow(
      'System certificate lifecycle service is required'
    );
  });

  it('issues managed database leaves through an explicit lifecycle owner', async () => {
    const { service, certService } = databaseCAService();
    const issueCurrent = vi.fn().mockResolvedValue({ certificate: {}, privateKeyPem: 'key' });
    service.setSystemCertificateLifecycleService({ issueCurrent } as any);

    await service.issueManagedDatabaseCertificate('database-1', ['203.0.113.15']);

    expect(issueCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ caId: 'database-ca-id', commonName: 'managed-db-database-1', sans: ['203.0.113.15'] }),
      expect.any(String),
      { type: 'managed_database', id: 'database-1' },
      undefined
    );
    expect(certService.issueCertificate).not.toHaveBeenCalled();
  });

  it('forwards the owner binding into the lifecycle transaction', async () => {
    const { service } = databaseCAService();
    const issueCurrent = vi.fn().mockResolvedValue({ certificate: {}, privateKeyPem: 'key' });
    const binding = vi.fn();
    service.setSystemCertificateLifecycleService({ issueCurrent } as any);

    await service.issueManagedDatabaseCertificate('database-1', ['203.0.113.15'], binding);

    expect(issueCurrent).toHaveBeenLastCalledWith(expect.any(Object), expect.any(String), expect.any(Object), binding);
  });

  it('retires only the explicitly owned database leaves on deletion', async () => {
    const { service } = databaseCAService();
    const retireOwner = vi.fn().mockResolvedValue(2);
    service.setSystemCertificateLifecycleService({ retireOwner } as any);

    await expect(service.retireManagedDatabaseCertificates('database-1')).resolves.toBe(2);
    expect(retireOwner).toHaveBeenCalledWith(
      { type: 'managed_database', id: 'database-1' },
      'cessationOfOperation',
      undefined
    );
  });
});
