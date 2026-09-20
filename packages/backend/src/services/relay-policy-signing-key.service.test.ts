import { describe, expect, it } from 'vitest';
import { relayPolicySigningKeyInternals } from './relay-policy-signing-key.service.js';

describe('Relay policy signing key rotation acknowledgements', () => {
  it('promotes only after every participating remote relay reports the pending key', () => {
    const acknowledged = { health: { policySigningKeyIds: ['old', 'next'] } };
    const stale = { health: { policySigningKeyIds: ['old'] } };

    expect(relayPolicySigningKeyInternals.allPolicyKeysAcknowledged([], 'next')).toBe(true);
    expect(relayPolicySigningKeyInternals.allPolicyKeysAcknowledged([acknowledged], 'next')).toBe(true);
    expect(relayPolicySigningKeyInternals.allPolicyKeysAcknowledged([acknowledged, stale], 'next')).toBe(false);
    expect(relayPolicySigningKeyInternals.allPolicyKeysAcknowledged([{ health: null }], 'next')).toBe(false);
  });

  it('never promotes past a local relay that has not seen the pending key', () => {
    const { allPolicyKeysAcknowledged, rotationParticipants } = relayPolicySigningKeyInternals;
    const local = (ids: string[], state = 'ready') => ({ kind: 'local', state, health: { policySigningKeyIds: ids } });
    const remote = (ids: string[], state: string) => ({ kind: 'remote', state, health: { policySigningKeyIds: ids } });

    // The installation that broke: one local relay, no remote ones, relay knows only the old key.
    expect(allPolicyKeysAcknowledged(rotationParticipants([local(['old'])]), 'next')).toBe(false);
    expect(allPolicyKeysAcknowledged(rotationParticipants([local(['old', 'next'])]), 'next')).toBe(true);
    // A local relay that is down still pins the old key and must not be skipped.
    expect(allPolicyKeysAcknowledged(rotationParticipants([local(['old'], 'offline')]), 'next')).toBe(false);
    // A remote relay that left the pool does not hold the rotation back.
    expect(
      allPolicyKeysAcknowledged(rotationParticipants([local(['old', 'next']), remote(['old'], 'offline')]), 'next')
    ).toBe(true);
    expect(
      allPolicyKeysAcknowledged(rotationParticipants([local(['old', 'next']), remote(['old'], 'ready')]), 'next')
    ).toBe(false);
  });
});
