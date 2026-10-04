import { describe, expect, it } from 'vitest';
import { assertOfflineRelayCoverage, relayRemovableAfter } from './relay-removal.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');

function offlineRelay(policyExpiresAt: string | null, lastSeenAt: string | null) {
  return {
    id: 'relay-1',
    state: 'offline',
    policyExpiresAt: policyExpiresAt ? new Date(policyExpiresAt) : null,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt) : null,
  } as never;
}

function refusal(relay: never) {
  try {
    assertOfflineRelayCoverage(relay, [relay], [], [], NOW);
  } catch (error) {
    return error as { code: string; message: string; details: unknown };
  }
  throw new Error('removal was not refused');
}

describe('offline relay removal', () => {
  it('names when removal becomes possible: the policy expiry or 90 s after the relay was last seen', () => {
    expect(relayRemovableAfter(offlineRelay('2026-10-05T08:00:00Z', '2026-10-04T11:59:00Z'))).toEqual(
      new Date('2026-10-05T08:00:00Z')
    );
    expect(relayRemovableAfter(offlineRelay('2026-10-04T11:00:00Z', '2026-10-04T11:59:30Z'))).toEqual(
      new Date('2026-10-04T12:01:00Z')
    );
    expect(relayRemovableAfter(offlineRelay(null, '2026-10-04T11:00:00Z'))).toBeNull();
    expect(
      relayRemovableAfter({ state: 'ready', policyExpiresAt: new Date('2026-10-04T11:00:00Z'), lastSeenAt: null })
    ).toBeNull();
  });

  it('refuses a relay whose policy has not expired and tells when it can be removed', () => {
    const error = refusal(offlineRelay('2026-10-05T08:00:00Z', '2026-10-04T11:00:00Z'));

    expect(error.code).toBe('RELAY_OFFLINE_REMOVAL_UNSAFE');
    expect(error.message).toContain('it can be removed after 2026-10-05T08:00:00.000Z');
    expect(error.details).toEqual({
      removableAfter: '2026-10-05T08:00:00.000Z',
      policyExpiresAt: '2026-10-05T08:00:00.000Z',
      lastSeenAt: '2026-10-04T11:00:00.000Z',
    });
  });

  it('refuses a relay seen less than 90 s ago until 90 s have passed', () => {
    const error = refusal(offlineRelay('2026-10-04T10:00:00Z', '2026-10-04T11:59:45Z'));

    expect(error.details).toMatchObject({ removableAfter: '2026-10-04T12:01:15.000Z' });
  });

  it('allows the removal once both conditions hold', () => {
    const relay = offlineRelay('2026-10-04T10:00:00Z', '2026-10-04T11:58:00Z');
    expect(() => assertOfflineRelayCoverage(relay, [relay], [], [], NOW)).not.toThrow();
  });
});
