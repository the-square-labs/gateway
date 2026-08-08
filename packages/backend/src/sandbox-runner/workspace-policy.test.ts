import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateWorkspaceAdmission,
  measureWorkspaceUsageBytes,
  remainingWorkspaceReservationBytes,
} from './workspace-policy.js';

let tempDir = '';

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

describe('sandbox workspace admission', () => {
  it('rejects a reservation that would reach 80% of the workspace filesystem', () => {
    expect(
      evaluateWorkspaceAdmission({
        totalBytes: 1000,
        usedBytes: 500,
        activeReservationBytes: 100,
        requestedReservationBytes: 200,
      })
    ).toMatchObject({ allowed: false, limitBytes: 800, projectedBytes: 800 });
  });

  it('accounts for persisted active reservations as well as current filesystem use', () => {
    expect(
      evaluateWorkspaceAdmission({
        totalBytes: 10_000,
        usedBytes: 4_000,
        activeReservationBytes: 1_500,
        requestedReservationBytes: 1_000,
      })
    ).toMatchObject({ allowed: true, limitBytes: 8_000, projectedBytes: 6_500 });
  });

  it('fails closed when filesystem capacity cannot be determined', () => {
    expect(
      evaluateWorkspaceAdmission({
        totalBytes: 0,
        usedBytes: 0,
        activeReservationBytes: 0,
        requestedReservationBytes: 1,
      }).allowed
    ).toBe(false);
  });

  it('fails closed for an invalid reservation', () => {
    expect(
      evaluateWorkspaceAdmission({
        totalBytes: 10_000,
        usedBytes: 1_000,
        activeReservationBytes: 0,
        requestedReservationBytes: -1,
      }).allowed
    ).toBe(false);
  });

  it('reserves only the capacity an active workspace can still consume', () => {
    expect(remainingWorkspaceReservationBytes(2_000, 750)).toBe(1_250);
    expect(remainingWorkspaceReservationBytes(2_000, 2_500)).toBe(0);
    expect(remainingWorkspaceReservationBytes(0, 0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('measures actual files without following workspace symlinks', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-workspace-policy-'));
    await writeFile(path.join(tempDir, 'artifact.bin'), Buffer.alloc(1024));

    await expect(measureWorkspaceUsageBytes(tempDir)).resolves.toBeGreaterThanOrEqual(1024);
  });
});
