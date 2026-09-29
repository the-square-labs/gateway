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

  it('tracks every audit write so shutdown closes the pool only after it', async () => {
    const { backgroundWrites } = await import('@/services/background-writes.js');
    let finishInsert!: () => void;
    const values = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishInsert = resolve;
        })
    );
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any);
    const before = backgroundWrites.pendingWrites;

    const written = service.log({ userId: null, action: 'node.disconnected', resourceType: 'node' });
    expect(backgroundWrites.pendingWrites).toBe(before + 1);
    let drained = false;
    const drain = backgroundWrites
      .drain({ deadline: Date.now() + 5_000, sourcesDeadline: 0 })
      .then(() => (drained = true));
    await vi.waitFor(() => expect(values).toHaveBeenCalled());
    expect(drained).toBe(false);

    finishInsert();
    await expect(written).resolves.toBe(true);
    await drain;
    expect(drained).toBe(true);
  });

  it('publishes an audit change after a successful insert', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const eventBus = { publish: vi.fn() };
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any);
    service.setEventBus(eventBus as any);

    await service.log({ userId: 'user-1', action: 'node.update', resourceType: 'node' });

    expect(eventBus.publish).toHaveBeenCalledWith('audit.changed', {});
  });

  it('records an event Gateway learned about afterwards at the time it happened, never in the future', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const service = new AuditService({ insert: vi.fn(() => ({ values })) } as any);
    const happened = new Date(Date.now() - 70_000);

    await service.log({
      userId: null,
      action: 'docker.availability.lease_failover',
      resourceType: 'x',
      occurredAt: happened,
    });
    expect(values.mock.calls[0]![0]).toMatchObject({ createdAt: happened });
    expect(values.mock.calls[0]![0]).not.toHaveProperty('occurredAt');

    const before = Date.now();
    await service.log({
      userId: null,
      action: 'docker.availability.lease_failover',
      resourceType: 'x',
      occurredAt: new Date(Date.now() + 3_600_000),
    });
    expect((values.mock.calls[1]![0].createdAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((values.mock.calls[1]![0].createdAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
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
          userId: '11111111-1111-4111-8111-111111111111',
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
          actorUserId: '22222222-2222-4222-8222-222222222222',
          subjectUserId: '33333333-3333-4333-8333-333333333333',
          subjectEmail: 'subject@example.com',
          subjectName: 'Subject',
        },
      },
      () =>
        service.log({
          userId: '33333333-3333-4333-8333-333333333333',
          action: 'proxy_host.update',
          resourceType: 'proxy_host',
          details: { domain: 'example.com' },
        })
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '22222222-2222-4222-8222-222222222222',
        details: {
          domain: 'example.com',
          impersonatedUserId: '33333333-3333-4333-8333-333333333333',
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
