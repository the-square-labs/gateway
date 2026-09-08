import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  hasChannelAccess,
  hasHostingSnapshotEventAccess,
  projectHostingSnapshotEvent,
} from './events-channel-access.js';

describe('SSL certificate event channel access', () => {
  it('projects snapshot billing per connector and recipient without altering shared events', () => {
    const event = Object.freeze({
      connectorId: 'account',
      resourceId: 'vm',
      nodeIds: ['node'],
      snapshot: Object.freeze({
        entityId: 'snapshot',
        status: 'ready',
        monthlyCost: { amount: '0.16', currency: 'USD' },
        storageRate: { amount: '0.06' },
      }),
    });
    for (const scopes of [
      [],
      ['hosting:billing:view:other'],
      ['integrations:hosting:manage'],
      ['hosting:snapshots:view'],
      ['*'],
    ]) {
      expect(projectHostingSnapshotEvent(scopes, event)).toEqual({
        ...event,
        snapshot: { entityId: 'snapshot', status: 'ready' },
      });
    }
    for (const scopes of [['hosting:billing:view'], ['hosting:billing:view:account']]) {
      expect(projectHostingSnapshotEvent(scopes, event)).toBe(event);
    }
    expect((projectHostingSnapshotEvent([], event) as any).snapshot).not.toHaveProperty('monthlyCost');
    expect(event.snapshot.monthlyCost.amount).toBe('0.16');
    expect(
      (projectHostingSnapshotEvent(['hosting:billing:view'], { ...event, connectorId: undefined }) as any).snapshot
    ).not.toHaveProperty('monthlyCost');
  });
  it('restricts snapshot entity events to the VM and all bound nodes', () => {
    const scopes = [
      'hosting:snapshots:view:vm',
      'hosting:resources:view:vm',
      'nodes:details:a',
      'integrations:hosting:view:account',
    ];
    expect(hasChannelAccess(scopes, 'hosting.snapshot.changed')).toBe(true);
    expect(hasChannelAccess(scopes, 'hosting.snapshot.folder.changed')).toBe(true);
    expect(hasChannelAccess(['integrations:hosting:view'], 'hosting.snapshot.folder.changed')).toBe(false);
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'account', nodeIds: ['a'] })).toBe(
      true
    );
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'other', nodeIds: ['a'] })).toBe(
      false
    );
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'other', connectorId: 'account', nodeIds: ['a'] })).toBe(
      false
    );
    expect(
      hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', connectorId: 'account', nodeIds: ['a', 'b'] })
    ).toBe(false);
    expect(hasHostingSnapshotEventAccess(scopes, { resourceId: 'vm', nodeIds: [] })).toBe(false);
    expect(hasChannelAccess(['integrations:hosting:view'], 'hosting.snapshot.changed')).toBe(false);
  });
  it('never exposes internal hosting observations or billing through WebSocket subscriptions', () => {
    for (const channel of [
      'hosting.account.observed',
      'hosting.vm.observed',
      'hosting.operation.changed',
      'hosting.firewall.observed',
    ]) {
      expect(hasChannelAccess(['*'], channel)).toBe(false);
      expect(hasChannelAccess(['integrations:hosting:view'], channel)).toBe(false);
    }
  });
  it('separates folder layout events from certificate lifecycle metadata', () => {
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.changed')).toBe(false);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.changed')).toBe(true);
  });
});
