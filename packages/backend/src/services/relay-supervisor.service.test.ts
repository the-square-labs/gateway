import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import { RelayRecoverySafetyError } from './relay-docker-recovery.service.js';
import { RelaySupervisorService } from './relay-supervisor.service.js';

function healthy() {
  return {
    buildVersion: '1',
    protocolMajor: 1,
    appliedRevision: '1',
    keyIds: ['key-1'],
    registeredEndpoints: '0',
    activeTunnels: '0',
    liveness: true,
    readiness: true,
    reason: '',
  };
}

function harness(options: { getHealth?: ReturnType<typeof vi.fn>; recover?: ReturnType<typeof vi.fn> } = {}) {
  let persisted: unknown = null;
  const cache = {
    get: vi.fn(async () => persisted),
    set: vi.fn(async (_key: string, value: unknown) => {
      persisted = structuredClone(value);
    }),
  };
  const getHealth = options.getHealth ?? vi.fn().mockResolvedValue(healthy());
  const recover = options.recover ?? vi.fn().mockResolvedValue('restart');
  const events = { publish: vi.fn() };
  const audit = { log: vi.fn() };
  const supervisor = new RelaySupervisorService(
    {
      transaction: async (callback: (tx: { execute: ReturnType<typeof vi.fn> }) => unknown) =>
        callback({ execute: vi.fn() }),
    } as never,
    cache as never,
    { getHealth } as never,
    { recover } as never,
    { getConfig: vi.fn().mockResolvedValue({ relayAutoRecovery: true }) } as never,
    events as never,
    audit as never,
    {
      required: true,
      managed: true,
      expectedImage: `gateway@sha256:${'a'.repeat(64)}`,
      expectedService: 'relay',
      expectedVersion: '1',
      expectedProtocolMajor: 1,
      probeIntervalMs: 60_000,
      recoveryDelaysMs: [0, 0, 0],
      readinessWaitMs: 1,
      readinessPollMs: 1,
      sleep: async () => {},
    }
  );
  return { supervisor, getHealth, recover, events, audit, cache };
}

describe('RelaySupervisorService', () => {
  it('does not render the first suspect failure as a critical incident', async () => {
    const { supervisor } = harness({ getHealth: vi.fn().mockRejectedValue(new Error('connect refused')) });
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'suspect', reason: 'unreachable', attempt: 0 });
  });

  it('recovers only after two consecutive liveness failures', async () => {
    const getHealth = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue(healthy());
    const { supervisor, recover } = harness({ getHealth });
    await supervisor.probeNow();
    expect(recover).not.toHaveBeenCalled();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('locks out after the bounded three-action budget', async () => {
    const { supervisor, recover } = harness({ getHealth: vi.fn().mockRejectedValue(new Error('connect refused')) });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical' }));
    expect(recover).toHaveBeenCalledTimes(3);
  });

  it('reports unverifiable managed ownership as degraded instead of a relay outage', async () => {
    const recover = vi
      .fn()
      .mockRejectedValue(
        new RelayRecoverySafetyError('ownership_unverified', 'Compose relay ownership labels are invalid')
      );
    const { supervisor } = harness({
      getHealth: vi.fn().mockRejectedValue(new Error('connect refused')),
      recover,
    });

    await supervisor.probeNow();
    await supervisor.probeNow();

    await vi.waitFor(() =>
      expect(supervisor.getSnapshot(true)).toMatchObject({
        state: 'degraded',
        reason: 'ownership_unverified',
        canRetry: false,
      })
    );
  });

  it('never restarts for a contract failure', async () => {
    const contractFailure = { ...healthy(), readiness: false, dataPlaneHealthy: false, reason: 'contract_mismatch' };
    const { supervisor, recover } = harness({ getHealth: vi.fn().mockResolvedValue(contractFailure) });
    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', reason: 'contract_mismatch' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('probes before resuming a persisted recovery cycle after app restart', async () => {
    const { supervisor, recover, cache } = harness({ getHealth: vi.fn().mockResolvedValue(healthy()) });
    await cache.set('relay:control-state', {
      state: 'recovering',
      reason: 'unreachable',
      attempt: 1,
      maxAttempts: 3,
      attemptHistory: [
        {
          attempt: 1,
          startedAt: '2026-08-07T12:00:00.000Z',
          action: 'restart',
          result: 'failed',
        },
      ],
      lastHealthyAt: null,
      lastProbeAt: '2026-08-07T12:00:00.000Z',
      relayBuildVersion: '1',
      protocolMajor: 1,
    });

    await supervisor.start();

    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 });
    expect(recover).not.toHaveBeenCalled();
    supervisor.stop();
  });

  it('treats a healthy but obsolete relay version as a non-recoverable contract mismatch', async () => {
    const { supervisor, recover } = harness({
      getHealth: vi.fn().mockResolvedValue({ ...healthy(), buildVersion: '0' }),
    });
    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', reason: 'contract_mismatch' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('treats an incompatible relay protocol major as a non-recoverable contract mismatch', async () => {
    const { supervisor, recover } = harness({
      getHealth: vi.fn().mockResolvedValue({ ...healthy(), protocolMajor: 2 }),
    });
    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', reason: 'contract_mismatch' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('filters diagnostics from the all-user snapshot', async () => {
    const { supervisor } = harness({ getHealth: vi.fn().mockResolvedValue(healthy()) });
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(false)).not.toHaveProperty('expectedImage');
    expect(supervisor.getSnapshot(false)).not.toHaveProperty('reason');
    expect(supervisor.getSnapshot(true)).toMatchObject({ expectedService: 'relay', relayBuildVersion: '1' });
  });

  it('publishes relay-owned resource telemetry from the health response', async () => {
    const { supervisor } = harness({
      getHealth: vi.fn().mockResolvedValue({
        ...healthy(),
        pressurePercent: 12,
        cpuPressurePercent: 12,
        memoryPressurePercent: 0,
        fdPressurePercent: 1,
        memoryRssBytes: String(18 * 1024 * 1024),
        heapInUseBytes: String(6 * 1024 * 1024),
        memoryLimitBytes: '0',
        openFileDescriptors: '42',
        fileDescriptorLimit: '1048576',
      }),
    });

    await supervisor.probeNow();

    expect(supervisor.getSnapshot(true)).toMatchObject({
      pressurePercent: 12,
      cpuPressurePercent: 12,
      memoryPressurePercent: 0,
      memoryRssBytes: 18 * 1024 * 1024,
      heapInUseBytes: 6 * 1024 * 1024,
      memoryLimitBytes: 0,
      openFileDescriptors: 42,
      fileDescriptorLimit: 1_048_576,
    });
  });

  it('does not start manual recovery while the relay is healthy or only suspect', async () => {
    const getHealth = vi.fn().mockResolvedValueOnce(healthy()).mockRejectedValueOnce(new Error('connect refused'));
    const { supervisor, recover, audit } = harness({ getHealth });

    await supervisor.probeNow();
    await supervisor.retryRecovery('admin-1');
    expect(recover).not.toHaveBeenCalled();

    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'suspect' });
    await supervisor.retryRecovery('admin-1');
    expect(recover).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.retry' }));
  });

  it('does not offer or run recovery for a non-recoverable contract fault', async () => {
    const getHealth = vi
      .fn()
      .mockResolvedValueOnce({ ...healthy(), readiness: false, dataPlaneHealthy: false, reason: 'contract_mismatch' })
      .mockResolvedValueOnce({ ...healthy(), readiness: false, dataPlaneHealthy: false, reason: 'contract_mismatch' });
    const { supervisor, recover, audit } = harness({ getHealth });

    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', canRetry: false });

    await supervisor.retryRecovery('admin-1');
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', reason: 'contract_mismatch' });
    expect(recover).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.retry' }));
  });

  it('does not offer or run recovery for a relay TLS authentication fault', async () => {
    const tlsFailure = Object.assign(new Error('certificate rejected'), { code: grpc.status.PERMISSION_DENIED });
    const { supervisor, recover } = harness({ getHealth: vi.fn().mockRejectedValue(tlsFailure) });

    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({
      state: 'critical',
      reason: 'tls_unavailable',
      canRetry: false,
    });

    await supervisor.retryRecovery('admin-1');
    expect(recover).not.toHaveBeenCalled();
  });

  it('re-probes a recoverable critical snapshot and leaves an already recovered relay untouched', async () => {
    const getHealth = vi.fn().mockRejectedValue(new Error('connect refused'));
    const { supervisor, recover, audit } = harness({ getHealth });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', canRetry: true }));
    recover.mockClear();
    getHealth.mockResolvedValue(healthy());

    await supervisor.retryRecovery('admin-1');
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', canRetry: false });
    expect(recover).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.retry' }));
  });

  it('starts a fresh bounded budget only for a still-unreachable critical relay', async () => {
    const { supervisor, recover, audit } = harness({
      getHealth: vi.fn().mockRejectedValue(new Error('connect refused')),
    });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', canRetry: true }));
    recover.mockClear();

    await supervisor.retryRecovery('admin-1');
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', canRetry: true }));
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.retry' }));
  });

  it('does not race manual recovery against an in-flight periodic probe', async () => {
    let finishProbe: ((value: ReturnType<typeof healthy>) => void) | null = null;
    const inFlightHealth = new Promise<ReturnType<typeof healthy>>((resolve) => {
      finishProbe = resolve;
    });
    const getHealth = vi
      .fn()
      .mockResolvedValueOnce({ ...healthy(), readiness: false, dataPlaneHealthy: false, reason: 'contract_mismatch' })
      .mockResolvedValueOnce({ ...healthy(), readiness: false, dataPlaneHealthy: false, reason: 'contract_mismatch' })
      .mockReturnValueOnce(inFlightHealth);
    const { supervisor, recover } = harness({ getHealth });

    await supervisor.probeNow();
    await supervisor.probeNow();
    const probe = supervisor.probeNow();
    await supervisor.retryRecovery('admin-1');
    expect(recover).not.toHaveBeenCalled();

    (finishProbe as unknown as (value: ReturnType<typeof healthy>) => void)(healthy());
    await probe;
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' });
  });

  it('does not restore maintenance left by a process that stopped during a relay update', async () => {
    const { supervisor, cache, getHealth } = harness();
    await cache.set('relay:control-state', {
      state: 'maintenance',
      reason: null,
      attempt: 0,
      maxAttempts: 3,
      attemptHistory: [],
      lastHealthyAt: null,
      lastProbeAt: null,
      relayBuildVersion: '1',
      protocolMajor: 1,
    });

    await supervisor.start();

    // Probing resumed: a persisted maintenance state used to switch supervision off for good.
    expect(getHealth).toHaveBeenCalled();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' });
    await supervisor.stop();
  });

  it('contains an internal failure of a recovery cycle instead of crashing the process', async () => {
    const { supervisor, cache } = harness({ getHealth: vi.fn().mockRejectedValue(new Error('connect refused')) });
    await supervisor.probeNow();
    cache.set.mockImplementation(async (_key: string, value: any) => {
      if (value?.state === 'recovering' && value.attempt === 1) throw new Error('redis restarted');
    });
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical' }));
  });

  it('stops a recovery cycle when the relay recovered on its own between attempts', async () => {
    let supervisorRef: RelaySupervisorService | null = null;
    // Unreachable until the first attempt has failed its readiness wait, healthy afterwards.
    const getHealth = vi.fn(async () => {
      const history = (supervisorRef?.getSnapshot(true) as any)?.attemptHistory ?? [];
      if (history.some((record: any) => record.attempt === 1 && record.result === 'failed')) return healthy();
      throw new Error('connect refused');
    });
    const { supervisor, recover } = harness({ getHealth });
    supervisorRef = supervisor;
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
    // One restart; the second attempt found a healthy relay and left it alone.
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('acts on a new failure cause of a critical relay instead of a stale one', async () => {
    const notReady = { ...healthy(), readiness: false, reason: 'policy snapshot expired' };
    const getHealth = vi
      .fn()
      .mockResolvedValueOnce(notReady)
      .mockResolvedValueOnce(notReady)
      .mockRejectedValue(new Error('connect refused'));
    const { supervisor, recover } = harness({ getHealth });
    await supervisor.probeNow();
    await supervisor.probeNow();
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', reason: 'policy_snapshot_required' });
    expect(recover).not.toHaveBeenCalled();

    // Now the container is gone: that is recoverable, and recovery starts.
    await supervisor.probeNow();
    await vi.waitFor(() => expect(recover).toHaveBeenCalled());
  });
});
