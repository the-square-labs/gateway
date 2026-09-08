import { describe, expect, it } from 'vitest';
import type { HostingSnapshotEntityRow } from './hosting-snapshot-entities.js';
import {
  hasUnresolvedPendingSnapshotName,
  publicHostingSnapshotEntity,
  shouldMergeProviderSnapshot,
  shouldTombstoneMissingSnapshot,
  snapshotEntityNeedsTransition,
  snapshotPredatesObservation,
} from './hosting-snapshot-entities.js';

function entity(overrides: Partial<HostingSnapshotEntityRow> = {}): HostingSnapshotEntityRow {
  const timestamp = new Date('2026-09-08T10:00:00.000Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    resourceId: '22222222-2222-4222-8222-222222222222',
    incarnation: 'vm-original',
    operationId: '33333333-3333-4333-8333-333333333333',
    providerSnapshotId: 'provider-snapshot',
    fingerprint: 'f'.repeat(64),
    name: 'before-upgrade',
    status: 'ready',
    includeRam: true,
    data: {
      id: 'provider-snapshot',
      name: 'before-upgrade',
      createdAt: '2026-09-08T09:00:00.000Z',
      fingerprint: 'f'.repeat(64),
      sizeGb: 8,
      minDiskGb: 20,
      ready: true,
    },
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('hosting snapshot entities', () => {
  it('protects lifecycle changes in the same millisecond as an older provider observation', () => {
    const start = new Date('2026-09-08T10:00:00.000Z');
    expect(snapshotPredatesObservation(entity({ updatedAt: start }), start)).toBe(false);
    expect(snapshotPredatesObservation(entity({ updatedAt: new Date(start.getTime() + 1) }), start)).toBe(false);
    expect(snapshotPredatesObservation(entity({ updatedAt: new Date(start.getTime() - 1) }), start)).toBe(true);
  });
  it('keeps entity layout identity while exposing the provider snapshot ID', () => {
    const row = entity();
    expect(publicHostingSnapshotEntity(row)).toMatchObject({
      id: 'provider-snapshot',
      entityId: row.id,
      layoutId: row.id,
      providerSnapshotId: 'provider-snapshot',
      status: 'ready',
      includeRam: true,
      revision: '2026-09-08T10:00:00.000Z',
    });
  });

  it('uses the optimistic entity ID until a provider fingerprint exists', () => {
    const row = entity({
      providerSnapshotId: null,
      fingerprint: null,
      status: 'pending',
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'before-upgrade',
        createdAt: null,
        fingerprint: '11111111-1111-4111-8111-111111111111',
        sizeGb: null,
        minDiskGb: null,
        ready: false,
      },
    });
    const dto = publicHostingSnapshotEntity(row);
    expect(dto.id).toBe(row.id);
    expect(dto.fingerprint).toBe(row.id);
    expect(dto.layoutId).toBe(row.id);
    expect(dto.ready).toBe(false);
  });

  it('preserves unresolved pending names and avoids no-op refresh revisions', () => {
    const ready = entity();
    const pending = entity({ id: '44444444-4444-4444-8444-444444444444', providerSnapshotId: null, status: 'pending' });
    expect(hasUnresolvedPendingSnapshotName([ready, pending], pending.name)).toBe(true);
    expect(
      snapshotEntityNeedsTransition(ready, {
        status: 'ready',
        error: null,
        providerSnapshotId: 'provider-snapshot',
        fingerprint: 'f'.repeat(64),
        data: ready.data,
      })
    ).toBe(false);
    expect(snapshotEntityNeedsTransition(ready, { error: 'provider failed' })).toBe(true);
  });

  it('only permits complete inventory to tombstone confirmed ready entities', () => {
    expect(shouldTombstoneMissingSnapshot(entity())).toBe(true);
    expect(shouldTombstoneMissingSnapshot(entity({ status: 'pending' }))).toBe(false);
    expect(shouldTombstoneMissingSnapshot(entity({ status: 'failed' }))).toBe(false);
    expect(shouldTombstoneMissingSnapshot(entity({ status: 'deleting' }))).toBe(false);
  });

  it('never lets a background inventory mask a failed or deleting lifecycle row', () => {
    expect(shouldMergeProviderSnapshot(entity())).toBe(true);
    expect(shouldMergeProviderSnapshot(entity({ status: 'pending' }))).toBe(true);
    expect(shouldMergeProviderSnapshot(entity({ status: 'failed' }))).toBe(false);
    expect(shouldMergeProviderSnapshot(entity({ status: 'deleting' }))).toBe(false);
    expect(shouldMergeProviderSnapshot(entity({ status: 'deleted' }))).toBe(false);
  });
});
