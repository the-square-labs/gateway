import { describe, expect, it } from 'vitest';
import { assertOfflineRelayCoverage } from './relay-removal.js';

const now = 1_000_000;
const dead = {
  id: 'dead',
  state: 'offline',
  lastSeenAt: new Date(1),
  policyExpiresAt: new Date(2),
  health: { activeTunnels: 99 },
} as any;
const live = {
  id: 'live',
  state: 'ready',
  lastSeenAt: new Date(now - 1_000),
  policyExpiresAt: new Date(now + 60_000),
} as any;
const generations = [{ id: 'g', endpointId: 'endpoint', state: 'active' }] as any;
const assignments = [
  { id: 'a', relayInstanceId: 'dead', assignmentGenerationId: 'g', targetRegistrationState: 'ready' },
  { id: 'b', relayInstanceId: 'live', assignmentGenerationId: 'g', targetRegistrationState: 'ready' },
] as any;

describe('offline relay removal coverage', () => {
  it('allows removal with a verified live peer without waiting for dead-node telemetry', () => {
    expect(() => assertOfflineRelayCoverage(dead, [dead, live], assignments, generations, now)).not.toThrow();
  });
  it.each([
    { state: 'ready' },
    { policyExpiresAt: new Date(now + 1) },
    { policyExpiresAt: null },
    { lastSeenAt: new Date(now) },
  ])('refuses a live or unfenced relay %j', (change) => {
    expect(() => assertOfflineRelayCoverage({ ...dead, ...change }, [live], assignments, generations, now)).toThrow(
      'offline with an expired policy'
    );
  });
  it.each([
    { state: 'offline' },
    { lastSeenAt: new Date(1) },
    { policyExpiresAt: new Date(1) },
  ])('refuses unready replacement %j', (change) => {
    expect(() => assertOfflineRelayCoverage(dead, [{ ...live, ...change }], assignments, generations, now)).toThrow(
      'ready remaining relay'
    );
  });
  it('refuses to orphan a workload or use an unregistered target', () => {
    expect(() => assertOfflineRelayCoverage(dead, [live], assignments.slice(0, 1), generations, now)).toThrow(
      'ready remaining relay'
    );
    expect(() =>
      assertOfflineRelayCoverage(
        dead,
        [live],
        [assignments[0], { ...assignments[1], targetRegistrationState: 'pending' }],
        generations,
        now
      )
    ).toThrow('ready remaining relay');
  });
  it('uses the current active replacement for retained old-generation assignments', () => {
    expect(() =>
      assertOfflineRelayCoverage(
        dead,
        [live],
        [assignments[0], { ...assignments[1], assignmentGenerationId: 'new' }],
        [
          { ...generations[0], state: 'draining' },
          { ...generations[0], id: 'new' },
        ],
        now
      )
    ).not.toThrow();
  });
});
