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
});
