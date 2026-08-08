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
          toolName: 'update_proxy_host',
          category: 'Proxy Hosts',
          arguments: { proxyHostId: 'proxy-1', token: '[REDACTED]' },
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
          toolName: 'update_proxy_host',
          category: 'Proxy Hosts',
          arguments: { proxyHostId: 'proxy-1', token: '[REDACTED]' },
          tokenPrefix: 'gwo_abc123',
          authType: 'oauth',
          clientId: 'client-1',
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
