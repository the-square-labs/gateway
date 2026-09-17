import { describe, expect, it, vi } from 'vitest';
import { LicenseModuleService } from './license-module.service.js';

function fixture(state: 'community' | 'ready' | 'unavailable' = 'community') {
  const calls: string[] = [];
  const license = {
    authorizeCommercialUpdate: vi.fn(async () => {
      calls.push('authorize');
      return { edition: 'commercial' };
    }),
  };
  const artifact = { imageRef: 'signed-current-image' };
  const updates = {
    getCurrentVersion: () => 'v3.0.0-rc.1',
    prepareGatewayUpdate: vi.fn(async () => {
      calls.push('manifest');
      return artifact;
    }),
    performUpdate: vi.fn(async () => {
      calls.push('verified-update');
    }),
  };
  const events = { publish: vi.fn() };
  const jobs: (() => void)[] = [];
  const service = new LicenseModuleService(
    license as never,
    { status: { state } } as never,
    updates as never,
    events as never,
    (job) => {
      jobs.push(job);
    }
  );
  return { service, license, updates, events, jobs, calls, artifact };
}

describe('paid module activation', () => {
  it('authorizes first, uses the current signed version, and schedules one normal update after the response', async () => {
    const f = fixture();
    const first = f.service.ensureAvailable();
    expect(f.service.ensureAvailable()).toBe(first);
    await expect(first).resolves.toEqual({ restarting: true });
    expect(f.calls).toEqual(['authorize', 'manifest']);
    expect(f.updates.performUpdate).not.toHaveBeenCalled();
    expect(f.license.authorizeCommercialUpdate).toHaveBeenCalledWith('v3.0.0-rc.1');
    expect(f.updates.prepareGatewayUpdate).toHaveBeenCalledWith('v3.0.0-rc.1');
    expect(f.jobs).toHaveLength(1);
    f.jobs[0]();
    expect(f.updates.performUpdate).toHaveBeenCalledExactlyOnceWith('v3.0.0-rc.1', f.artifact);
    await f.service.ensureAvailable();
    expect(f.jobs).toHaveLength(1);
  });

  it('does not restart when the matching module is already loaded', async () => {
    const f = fixture('ready');
    await expect(f.service.ensureAvailable()).resolves.toEqual({ restarting: false });
    expect(f.license.authorizeCommercialUpdate).not.toHaveBeenCalled();
    expect(f.jobs).toHaveLength(0);
  });

  it('does not download or schedule an update for a Community grant', async () => {
    const f = fixture();
    f.license.authorizeCommercialUpdate.mockResolvedValueOnce({ edition: 'community' });
    await expect(f.service.ensureAvailable()).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(f.updates.prepareGatewayUpdate).not.toHaveBeenCalled();
    expect(f.jobs).toHaveLength(0);
  });

  it('allows retry after manifest failure without starting an unverified update', async () => {
    const f = fixture('unavailable');
    f.updates.prepareGatewayUpdate.mockRejectedValueOnce(new Error('invalid signature'));
    await expect(f.service.ensureAvailable()).rejects.toThrow('invalid signature');
    expect(f.jobs).toHaveLength(0);
    await expect(f.service.ensureAvailable()).resolves.toEqual({ restarting: true });
    expect(f.jobs).toHaveLength(1);
  });

  it('clears failed preparation for retry when private file verification or staging fails', async () => {
    const f = fixture();
    f.updates.performUpdate.mockRejectedValueOnce(new Error('private file checksum mismatch'));
    await f.service.ensureAvailable();
    f.jobs[0]();
    await vi.waitFor(() =>
      expect(f.events.publish).toHaveBeenCalledWith(
        'system.update.changed',
        expect.objectContaining({ updating: false })
      )
    );
    await f.service.ensureAvailable();
    expect(f.jobs).toHaveLength(2);
  });
});
