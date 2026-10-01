import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AuditService } from './audit.service.js';
import { type AuditRequestContext, getAuditRequestContext } from './audit-request-context.js';
import { auditWebSocketSession } from './websocket-session-audit.js';

afterEach(() => container.reset());

describe('auditWebSocketSession', () => {
  it('records a console session opened under impersonation with the administrator as actor', async () => {
    let context: AuditRequestContext | undefined;
    const log = vi.fn(async () => {
      context = getAuditRequestContext();
      return true;
    });
    container.registerInstance(AuditService, { log } as never);
    const subject = { id: 'subject-id', email: 'user@example.com', name: 'User' };
    const actor = { id: 'admin-id', email: 'admin@example.com', name: 'Admin' };

    auditWebSocketSession(
      { ipAddress: '203.0.113.7' },
      { user: subject, impersonation: { actor, subject } } as never,
      { type: 'session', value: 'session-id' },
      { action: 'node.console.open', resourceType: 'node', resourceId: 'node-1', details: { execId: 'exec-1' } }
    );
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'subject-id',
        action: 'node.console.open',
        resourceId: 'node-1',
        details: { execId: 'exec-1', credential: 'session' },
      }),
      { markRequest: false }
    );
    expect(context).toMatchObject({
      ipAddress: '203.0.113.7',
      impersonation: { actorUserId: 'admin-id', subjectUserId: 'subject-id' },
    });
  });
});
