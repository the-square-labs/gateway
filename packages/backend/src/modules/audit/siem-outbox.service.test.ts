import { describe, expect, it, vi } from 'vitest';
import { SiemAuditOutboxService } from './siem-outbox.service.js';

describe('SiemAuditOutboxService', () => {
  const enabledSettings = () => ({ isFeatureEnabled: vi.fn().mockResolvedValue(true) });

  it('builds a frozen privacy-reduced event and caches the installation source', async () => {
    const licenseService = {
      getInstallationId: vi.fn().mockResolvedValue('installation-1'),
    };
    const service = new SiemAuditOutboxService(licenseService as never, enabledSettings() as never);

    const first = await service.buildEvent({
      auditLogId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
      action: 'proxy_host.update',
      actorId: 'user-1',
      actorEmail: 'admin@example.test',
      resourceType: 'proxy_host',
      resourceId: 'proxy-1',
      sourceIp: '203.0.113.20',
    });
    const second = await service.buildEvent({
      auditLogId: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date('2026-08-07T12:01:00.000Z'),
      action: 'proxy_host.delete',
      actorId: null,
      actorEmail: null,
      resourceType: 'proxy_host',
      resourceId: null,
      sourceIp: null,
    });

    expect(first).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      source: 'urn:wiolett:gateway:installation-1',
      type: 'com.wiolett.gateway.audit.v1',
      time: '2026-08-07T12:00:00.000Z',
      data: {
        action: 'proxy_host.update',
        actor: { id: 'user-1', email: 'admin@example.test' },
        resource: { type: 'proxy_host', id: 'proxy-1' },
        sourceIp: '203.0.113.20',
      },
    });
    expect(second.data.actor).toBeNull();
    expect(second.data.resource).toEqual({ type: 'proxy_host', id: null });
    expect(licenseService.getInstallationId).toHaveBeenCalledTimes(1);
  });

  it('bounds an unexpectedly long resource identifier without exporting audit details', async () => {
    const service = new SiemAuditOutboxService(
      {
        getInstallationId: vi.fn().mockResolvedValue('installation-1'),
      } as never,
      enabledSettings() as never
    );
    const event = await service.buildEvent({
      auditLogId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
      action: 'proxy_host.update',
      actorId: null,
      actorEmail: null,
      resourceType: 'proxy_host',
      resourceId: 'a'.repeat(2048),
      sourceIp: null,
    });

    expect(event.data.resource.id).toHaveLength(1024);
    expect(event).not.toHaveProperty('details');
  });

  it('does not create outbox rows while the SIEM feature is disabled', async () => {
    const settings = { isFeatureEnabled: vi.fn().mockResolvedValue(false) };
    const service = new SiemAuditOutboxService(
      { getInstallationId: vi.fn().mockResolvedValue('installation-1') } as never,
      settings as never
    );
    const tx = { select: vi.fn(), insert: vi.fn() };

    await service.enqueue(tx as never, 'audit-1', {} as never, new Date('2026-08-08T00:00:00.000Z'));

    expect(settings.isFeatureEnabled).toHaveBeenCalledWith('siemEnabled');
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
