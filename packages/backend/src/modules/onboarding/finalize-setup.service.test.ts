import { describe, expect, it, vi } from 'vitest';
import {
  FINALIZE_SETUP_STATE_KEY,
  FinalizeSetupService,
  type FinalizeSetupState,
  FinalizeSetupUnavailableError,
} from './finalize-setup.service.js';

function createDb(initial: FinalizeSetupState | null = null) {
  let row = initial ? { key: FINALIZE_SETUP_STATE_KEY, value: initial, updatedAt: new Date() } : undefined;
  const onConflictDoNothing = vi.fn(async () => {
    if (!row) row = { key: FINALIZE_SETUP_STATE_KEY, value: pendingState('owner-1'), updatedAt: new Date() };
  });
  const onConflictDoUpdate = vi.fn(async ({ set }: { set: { value: FinalizeSetupState; updatedAt: Date } }) => {
    row = { key: FINALIZE_SETUP_STATE_KEY, value: set.value, updatedAt: set.updatedAt };
  });
  const values = vi.fn((value: { key: string; value: FinalizeSetupState; updatedAt: Date }) => ({
    onConflictDoNothing: vi.fn(async () => {
      if (!row) row = value;
      await onConflictDoNothing();
    }),
    onConflictDoUpdate: vi.fn(async ({ set }: { set: { value: FinalizeSetupState; updatedAt: Date } }) => {
      await onConflictDoUpdate({ set });
    }),
  }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => (row ? [row] : [])) })),
      })),
    })),
    insert: vi.fn(() => ({ values })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        row = undefined;
      }),
    })),
  };
  return { db, values, getRow: () => row };
}

function pendingState(ownerUserId: string): FinalizeSetupState {
  return {
    version: 1,
    ownerUserId,
    dismissedAt: null,
    steps: {
      nodes: 'pending',
      ai_assistant: 'pending',
      inference: 'pending',
      cloudflare: 'pending',
      gitlab: 'pending',
      mfa: 'pending',
      invite_users: 'pending',
    },
  };
}

describe('FinalizeSetupService', () => {
  it('initializes checklist state for the wizard-created administrator', async () => {
    const harness = createDb();
    const service = new FinalizeSetupService(harness.db as never);

    await service.initializeOwner('owner-1');

    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: FINALIZE_SETUP_STATE_KEY,
        value: expect.objectContaining({ ownerUserId: 'owner-1', dismissedAt: null }),
      })
    );
  });

  it('only exposes state to its owner and hides it after dismissal', async () => {
    const harness = createDb(pendingState('owner-1'));
    const service = new FinalizeSetupService(harness.db as never);

    expect(await service.getForUser('other-user')).toBeNull();
    expect(await service.getForUser('owner-1')).toEqual({ steps: pendingState('owner-1').steps });

    await service.dismiss('owner-1');
    expect(await service.getForUser('owner-1')).toBeNull();
  });

  it('adds a pending invitation step when reading an existing checklist state', async () => {
    const legacyState = pendingState('owner-1');
    delete (legacyState.steps as Partial<FinalizeSetupState['steps']>).invite_users;
    const harness = createDb(legacyState);
    const service = new FinalizeSetupService(harness.db as never);

    await expect(service.getForUser('owner-1')).resolves.toMatchObject({
      steps: { invite_users: 'pending' },
    });
  });

  it('records configured and skipped outcomes without permitting a configured item to regress', async () => {
    const harness = createDb(pendingState('owner-1'));
    const service = new FinalizeSetupService(harness.db as never);

    await service.markStep('owner-1', 'mfa', 'configured');
    await expect(service.markStep('owner-1', 'mfa', 'skipped')).rejects.toThrow('cannot be skipped');
    await service.markStep('owner-1', 'gitlab', 'skipped');

    expect(harness.getRow()?.value).toMatchObject({
      steps: { mfa: 'configured', gitlab: 'skipped' },
    });
  });

  it('rejects mutations by a user who is not the setup owner', async () => {
    const harness = createDb(pendingState('owner-1'));
    const service = new FinalizeSetupService(harness.db as never);

    await expect(service.markStep('other-user', 'nodes', 'configured')).rejects.toBeInstanceOf(
      FinalizeSetupUnavailableError
    );
  });

  it('keeps a skipped MFA reminder separate from the dismissed checklist and lets its owner hide it', async () => {
    const harness = createDb(pendingState('owner-1'));
    const service = new FinalizeSetupService(harness.db as never);

    await service.markStep('owner-1', 'mfa', 'skipped');
    await service.dismiss('owner-1');
    await expect(service.shouldShowMfaReminder('owner-1')).resolves.toBe(true);

    await service.hideMfaReminder('owner-1');
    await expect(service.shouldShowMfaReminder('owner-1')).resolves.toBe(false);
    await expect(service.shouldShowMfaReminder('other-user')).resolves.toBe(false);
  });
});
