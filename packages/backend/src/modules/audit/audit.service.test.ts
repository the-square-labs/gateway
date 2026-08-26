import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { auditLog } from '@/db/schema/index.js';
import { AuditService } from './audit.service.js';
import { runWithAuditRequestContext } from './audit-request-context.js';

describe('auditLog schema', () => {
  it('stores resource IDs as text so Docker IDs can be audited', () => {
    expect(auditLog.resourceId.getSQLType()).toBe('text');
  });
});

describe('AuditService MCP context', () => {
  it('resolves the synthetic internal registry without querying the UUID registry table', async () => {
    const db = { select: vi.fn() };
    const service = new AuditService(db as any);

    const names = await (service as any).resolveResourceNames([
      { resourceType: 'docker-registry', resourceId: 'gateway-internal-registry' },
    ]);

    expect(names.get('docker-registry:gateway-internal-registry')).toBe('Internal Registry');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('publishes an audit change after a successful insert', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const eventBus = { publish: vi.fn() };
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any);
    service.setEventBus(eventBus as any);

    await service.log({ userId: 'user-1', action: 'node.update', resourceType: 'node' });

    expect(eventBus.publish).toHaveBeenCalledWith('audit.changed', {});
  });

  it('enriches domain audit entries with the MCP tool and redacted arguments', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) } as any;
    const service = new AuditService(db);

    await runWithAuditRequestContext(
      {
        auditEmitted: false,
        mcp: {
          toolName: 'update_route',
          category: 'Routes',
          arguments: { routeId: 'proxy-1', token: '[REDACTED]' },
          tokenPrefix: 'gwo_abc123',
          authType: 'oauth',
          clientId: 'client-1',
        },
      },
      () =>
        service.log({
          userId: 'user-1',
          action: 'proxy_host.update',
          resourceType: 'proxy_host',
          resourceId: 'proxy-1',
          details: { domainNames: ['example.com'] },
        })
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'proxy_host.update',
        details: {
          domainNames: ['example.com'],
          source: 'mcp',
          toolName: 'update_route',
          category: 'Routes',
          arguments: { routeId: 'proxy-1', token: '[REDACTED]' },
          tokenPrefix: 'gwo_abc123',
          authType: 'oauth',
          clientId: 'client-1',
        },
      })
    );
  });

  it('attributes impersonated actions to the administrator and records the subject', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any);

    await runWithAuditRequestContext(
      {
        impersonation: {
          actorUserId: 'actor-1',
          subjectUserId: 'subject-1',
          subjectEmail: 'subject@example.com',
          subjectName: 'Subject',
        },
      },
      () =>
        service.log({
          userId: 'subject-1',
          action: 'proxy_host.update',
          resourceType: 'proxy_host',
          details: { domain: 'example.com' },
        })
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'actor-1',
        details: {
          domain: 'example.com',
          impersonatedUserId: 'subject-1',
          impersonatedUserEmail: 'subject@example.com',
          impersonatedUserName: 'Subject',
        },
      })
    );
  });

  it('writes a matching SIEM outbox record in the audit transaction', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const tx = { insert: vi.fn(() => ({ values })), select: vi.fn() };
    const db = {
      transaction: vi.fn((callback: (writer: typeof tx) => Promise<void>) => callback(tx)),
      insert: vi.fn(() => ({ values })),
    } as any;
    const siemOutbox = {
      isEnabled: vi.fn().mockResolvedValue(true),
      buildEvent: vi.fn().mockResolvedValue({ id: 'event-1' }),
      enqueue: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuditService(db, siemOutbox as any);

    await service.log({ userId: null, action: 'node.update', resourceType: 'node', resourceId: 'node-1' });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(siemOutbox.buildEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'node.update', resourceType: 'node', resourceId: 'node-1' })
    );
    expect(siemOutbox.enqueue).toHaveBeenCalledWith(tx, expect.any(String), { id: 'event-1' }, expect.any(Date));
  });

  it('keeps local audit records but skips SIEM event construction while SIEM is disabled', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const siemOutbox = {
      isEnabled: vi.fn().mockResolvedValue(false),
      buildEvent: vi.fn(),
      enqueue: vi.fn(),
    };
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any, siemOutbox as any);

    await service.log({ userId: 'user-1', action: 'node.update', resourceType: 'node' });

    expect(values).toHaveBeenCalledOnce();
    expect(siemOutbox.buildEvent).not.toHaveBeenCalled();
    expect(siemOutbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('AuditService export', () => {
  it('uses the bounded export query and returns matching entries', async () => {
    const service = new AuditService({} as never);
    const entry = { id: 'audit-1' };
    const getAuditLog = vi.spyOn(service, 'getAuditLog').mockResolvedValue({
      data: [entry] as never,
      pagination: { page: 1, limit: 50_001, total: 1, totalPages: 1 },
    });

    await expect(service.getAuditExport({ actions: ['node.update'] })).resolves.toEqual([entry]);
    expect(getAuditLog).toHaveBeenCalledWith({ actions: ['node.update'], page: 1, limit: 50_001 });
  });

  it('rejects exports above the server-side entry ceiling', async () => {
    const service = new AuditService({} as never);
    vi.spyOn(service, 'getAuditLog').mockResolvedValue({
      data: [] as never,
      pagination: { page: 1, limit: 50_001, total: 50_001, totalPages: 1 },
    });

    await expect(service.getAuditExport({})).rejects.toMatchObject({
      statusCode: 413,
      code: 'AUDIT_EXPORT_TOO_LARGE',
    });
  });
});
