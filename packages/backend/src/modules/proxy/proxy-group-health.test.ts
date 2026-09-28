import { describe, expect, it } from 'vitest';
import { aggregateMemberOutcomes, withMemberIngressHealth } from './proxy-group-health.js';

describe('group route health', () => {
  it('is online when every member serves, degraded when some fail, offline when none serves', () => {
    expect(
      aggregateMemberOutcomes([
        { nodeId: 'a', status: 'online', responseMs: 10 },
        { nodeId: 'b', status: 'online', responseMs: 30 },
      ])
    ).toMatchObject({ status: 'online', responseMs: 20 });
    expect(
      aggregateMemberOutcomes([
        { nodeId: 'a', status: 'online', responseMs: 10 },
        { nodeId: 'b', status: 'offline', error: 'The ingress node is not connected' },
      ])
    ).toEqual({
      status: 'degraded',
      responseMs: 10,
      members: [
        { nodeId: 'a', status: 'online' },
        { nodeId: 'b', status: 'offline', error: 'The ingress node is not connected' },
      ],
    });
    expect(
      aggregateMemberOutcomes([
        { nodeId: 'a', status: 'offline' },
        { nodeId: 'b', status: 'offline' },
      ]).status
    ).toBe('offline');
  });

  it('ignores members whose probe could not run and skips a sample nothing could decide', () => {
    expect(
      aggregateMemberOutcomes([
        { nodeId: 'a', status: 'online' },
        { nodeId: 'b', status: 'skipped' },
      ]).status
    ).toBe('online');
    expect(aggregateMemberOutcomes([{ nodeId: 'a', status: 'skipped' }]).status).toBe('skipped');
    expect(
      aggregateMemberOutcomes([
        { nodeId: 'a', status: 'deferred' },
        { nodeId: 'b', status: 'unknown' },
      ]).status
    ).toBe('deferred');
    expect(aggregateMemberOutcomes([{ nodeId: 'a', status: 'unknown' }]).status).toBe('unknown');
  });

  it('folds the members ingress health into a direct upstream sample', () => {
    expect(
      withMemberIngressHealth('online', [
        { nodeId: 'a', connected: true, serving: true },
        { nodeId: 'b', connected: true, serving: null },
      ]).status
    ).toBe('online');
    expect(
      withMemberIngressHealth('online', [
        { nodeId: 'a', connected: true, serving: true },
        { nodeId: 'b', connected: false, serving: null },
      ])
    ).toMatchObject({
      status: 'degraded',
      members: [
        { nodeId: 'a', status: 'online' },
        { nodeId: 'b', status: 'offline', error: 'The ingress node is not connected' },
      ],
    });
    expect(withMemberIngressHealth('online', [{ nodeId: 'a', connected: true, serving: false }]).status).toBe(
      'offline'
    );
    expect(withMemberIngressHealth('offline', [{ nodeId: 'a', connected: true, serving: true }]).status).toBe(
      'offline'
    );
  });
});
