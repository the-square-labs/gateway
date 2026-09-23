import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { RelayPolicySigningKeyService, relayPolicySigningKeyInternals } from './relay-policy-signing-key.service.js';

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

type KeyRecord = Parameters<typeof relayPolicySigningKeyInternals.planInstancePolicyKeys>[0][number];

const NOW = new Date('2026-09-23T12:00:00Z');
const minutes = (value: number) => new Date(NOW.getTime() + value * 60_000);

function keyRecord(keyId: string, overrides: Partial<KeyRecord> = {}): KeyRecord {
  return {
    keyId,
    publicKey: Buffer.alloc(32, keyId.length).toString('base64'),
    publicKeyFingerprint: `sha256:${keyId}`,
    status: 'retired',
    activatedAt: null,
    verifyUntil: null,
    retiredAt: null,
    hasPrivateKey: false,
    ...overrides,
  };
}

function relay(reported: string[] | null, policySigningKeyId: string | null = null) {
  return { kind: 'remote', policySigningKeyId, health: reported ? { policySigningKeyIds: reported } : null };
}

describe('Relay policy signer selection per relay', () => {
  const { planInstancePolicyKeys } = relayPolicySigningKeyInternals;
  const records = () => [
    keyRecord('enroll', {
      activatedAt: minutes(-90 * 24 * 60),
      verifyUntil: minutes(-60 * 24 * 60),
      retiredAt: minutes(-60 * 24 * 60),
    }),
    keyRecord('old', { activatedAt: minutes(-60 * 24 * 60), verifyUntil: minutes(-30 * 24 * 60), hasPrivateKey: true }),
    keyRecord('previous', {
      status: 'verification_only',
      activatedAt: minutes(-30 * 24 * 60),
      verifyUntil: minutes(20),
      hasPrivateKey: true,
    }),
    keyRecord('current', { status: 'active', activatedAt: minutes(-10), hasPrivateKey: true }),
    keyRecord('next', { status: 'pending', hasPrivateKey: true }),
  ];

  it('signs with the active key for a relay that trusts it, and publishes only live keys', () => {
    const plan = planInstancePolicyKeys(records(), relay(['current', 'previous']), NOW);
    expect(plan.signingKeyId).toBe('current');
    expect(plan.keys.map(({ keyId, status }) => [keyId, status])).toEqual([
      ['current', 'active'],
      ['next', 'pending'],
      ['previous', 'verification_only'],
    ]);
  });

  it('signs with the active key while the relay has not reported its trust', () => {
    expect(planInstancePolicyKeys(records(), relay([]), NOW).signingKeyId).toBe('current');
    expect(planInstancePolicyKeys(records(), relay(null), NOW).signingKeyId).toBe('current');
  });

  it('signs a lagging relay with the newest retained key it trusts and still carries the active key', () => {
    const plan = planInstancePolicyKeys(records(), relay(['old']), NOW);
    expect(plan.signingKeyId).toBe('old');
    const signer = plan.keys.find(({ keyId }) => keyId === 'old');
    expect(signer).toMatchObject({ status: 'verification_only' });
    // Valid long enough for the relay to verify it again before its next report.
    expect(signer?.verifyUntil?.getTime()).toBeGreaterThanOrEqual(minutes(30).getTime());
    expect(plan.keys.find(({ keyId }) => keyId === 'current')).toMatchObject({ status: 'active' });

    expect(planInstancePolicyKeys(records(), relay(['old', 'previous']), NOW).signingKeyId).toBe('previous');
  });

  it('never signs with a pending key or a key whose private half is gone', () => {
    expect(planInstancePolicyKeys(records(), relay(['next']), NOW).signingKeyId).toBe('current');
    expect(planInstancePolicyKeys(records(), relay(['enroll']), NOW).signingKeyId).toBe('current');
  });

  it("keeps each relay's enrollment key as bounded verification-only trust", () => {
    const plan = planInstancePolicyKeys(records(), relay(['current'], 'enroll'), NOW);
    expect(plan.signingKeyId).toBe('current');
    const enrollment = plan.keys.find(({ keyId }) => keyId === 'enroll');
    expect(enrollment).toMatchObject({ status: 'verification_only', verifyUntil: minutes(-60 * 24 * 60) });

    const withoutWindow = records().map((record) =>
      record.keyId === 'enroll' ? { ...record, verifyUntil: null, retiredAt: null } : record
    );
    const fallback = planInstancePolicyKeys(withoutWindow, relay(['current'], 'enroll'), NOW).keys.find(
      ({ keyId }) => keyId === 'enroll'
    );
    // A zero window would mean "valid forever" to the relay.
    expect(fallback?.verifyUntil).toEqual(NOW);

    // An enrollment key that is still published is not duplicated.
    const current = planInstancePolicyKeys(records(), relay(['current'], 'current'), NOW);
    expect(current.keys.filter(({ keyId }) => keyId === 'current')).toHaveLength(1);
  });
});

describe('Relay policy old-key retention', () => {
  const { keysNeededByInstance, mayPromote, REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS } = relayPolicySigningKeyInternals;

  it('needs old keys only for relays that have not reported the active key', () => {
    expect(keysNeededByInstance(relay(['old', 'current']), 'current')).toEqual([]);
    expect(keysNeededByInstance(relay(['old', 'previous']), 'current')).toEqual(['old', 'previous']);
    expect(keysNeededByInstance(relay([], 'enroll'), 'current')).toEqual(['enroll']);
    expect(keysNeededByInstance(relay(null, 'enroll'), 'current')).toEqual(['enroll']);
    expect(keysNeededByInstance(relay(null), 'current')).toEqual([]);
  });

  it('stops waiting for remote relays that never acknowledge, but never for the local relay', () => {
    const pending = { keyId: 'next', createdAt: NOW };
    const local = (ids: string[]) => ({ kind: 'local', state: 'ready', health: { policySigningKeyIds: ids } });
    const stuck = { kind: 'remote', state: 'synchronizing', health: { policySigningKeyIds: ['current'] } };
    const beforeDeadline = new Date(NOW.getTime() + REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS - 1);
    const afterDeadline = new Date(NOW.getTime() + REMOTE_ACKNOWLEDGEMENT_DEADLINE_MS);

    expect(mayPromote([local(['current', 'next']), stuck], pending, beforeDeadline)).toBe(false);
    expect(mayPromote([local(['current', 'next']), stuck], pending, afterDeadline)).toBe(true);
    expect(mayPromote([local(['current']), stuck], pending, afterDeadline)).toBe(false);
  });
});

function rotationDb(results: unknown[][]) {
  const updates: Array<{ set: Record<string, unknown>; where?: unknown }> = [];
  const db: any = {
    execute: vi.fn(),
    select: () => {
      const rows = results.shift() ?? [];
      const query: any = {
        // biome-ignore lint/suspicious/noThenProperty: emulate Drizzle's lazy thenable query
        then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      };
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        const entry: { set: Record<string, unknown>; where?: unknown } = { set: values };
        updates.push(entry);
        return {
          where: (condition: unknown) => {
            entry.where = condition;
            return { returning: async () => [] };
          },
        };
      },
    }),
  };
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db, updates };
}

function whereParams(condition: unknown): unknown[] {
  return new PgDialect().sqlToQuery(condition as never).params;
}

describe('Relay policy private key lifecycle', () => {
  it('keeps the previous private key when a new key is promoted', async () => {
    const { db, updates } = rotationDb([
      [{ id: 'pending-row', keyId: 'next', createdAt: minutes(-60) }],
      [
        { kind: 'local', state: 'ready', health: { policySigningKeyIds: ['current', 'next'] } },
        { kind: 'remote', state: 'offline', health: { policySigningKeyIds: ['current'] } },
      ],
    ]);
    const service = new RelayPolicySigningKeyService(db, {} as never);

    await expect(service.promoteAcknowledgedPending(NOW)).resolves.toBe(true);
    expect(updates[0].set).toEqual({ status: 'verification_only', verifyUntil: minutes(30) });
    expect(updates[1].set).toEqual({ status: 'active', activatedAt: NOW });
  });

  it('destroys an old private key only once no enrolled relay still needs it', async () => {
    const held = [
      { id: 'old-row', keyId: 'old' },
      { id: 'older-row', keyId: 'older' },
    ];
    const lagging = { kind: 'remote', policySigningKeyId: 'older', health: { policySigningKeyIds: ['old'] } };
    const current = {
      kind: 'remote',
      policySigningKeyId: 'older',
      health: { policySigningKeyIds: ['current', 'old'] },
    };
    const local = { kind: 'local', policySigningKeyId: null, health: { policySigningKeyIds: ['current'] } };

    const withLagging = rotationDb([[{ keyId: 'current' }], held, [lagging, current, local]]);
    await expect(
      new RelayPolicySigningKeyService(withLagging.db, {} as never).destroyUnneededPrivateKeys(NOW)
    ).resolves.toBe(true);
    expect(withLagging.updates).toHaveLength(1);
    expect(withLagging.updates[0].set).toEqual({
      encryptedPrivateKey: null,
      encryptedDek: null,
      privateKeyDestroyedAt: NOW,
    });
    expect(whereParams(withLagging.updates[0].where)).toEqual(['older-row']);

    // An admin removed the lagging relay: nothing needs the old key any more.
    const removed = rotationDb([[{ keyId: 'current' }], held, [current, local]]);
    await expect(
      new RelayPolicySigningKeyService(removed.db, {} as never).destroyUnneededPrivateKeys(NOW)
    ).resolves.toBe(true);
    expect(whereParams(removed.updates[0].where)).toEqual(['old-row', 'older-row']);

    // A relay that has not reported yet will bootstrap from its enrollment key.
    const unreported = rotationDb([
      [{ keyId: 'current' }],
      [{ id: 'older-row', keyId: 'older' }],
      [{ kind: 'remote', policySigningKeyId: 'older', health: null }],
    ]);
    await expect(
      new RelayPolicySigningKeyService(unreported.db, {} as never).destroyUnneededPrivateKeys(NOW)
    ).resolves.toBe(false);
    expect(unreported.updates).toHaveLength(0);
  });
});
