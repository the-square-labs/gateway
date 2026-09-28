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

function harness(
  options: {
    getHealth?: ReturnType<typeof vi.fn>;
    recover?: ReturnType<typeof vi.fn>;
    inspectRelay?: ReturnType<typeof vi.fn>;
    readinessWaitMs?: number;
    clock?: { now: () => number; sleep: (ms: number) => Promise<void> };
  } = {}
) {
  let persisted: unknown = null;
  const cache = {
    get: vi.fn(async () => persisted),
    set: vi.fn(async (_key: string, value: unknown) => {
      persisted = structuredClone(value);
    }),
  };
  const getHealth = options.getHealth ?? vi.fn().mockResolvedValue(healthy());
  const recover = options.recover ?? vi.fn().mockResolvedValue('restart');
  const inspectRelay = options.inspectRelay ?? vi.fn().mockResolvedValue(null);
  const events = { publish: vi.fn() };
  const audit = { log: vi.fn() };
  const supervisor = new RelaySupervisorService(
    {
      transaction: async (callback: (tx: { execute: ReturnType<typeof vi.fn> }) => unknown) =>
        callback({ execute: vi.fn() }),
    } as never,
    cache as never,
    { getHealth } as never,
    { recover, inspectRelay } as never,
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
      readinessWaitMs: options.readinessWaitMs ?? 1,
      readinessPollMs: options.clock ? 1_000 : 1,
      sleep: options.clock?.sleep ?? (async () => {}),
      ...(options.clock ? { now: options.clock.now } : {}),
    }
  );
  return { supervisor, getHealth, recover, inspectRelay, events, audit, cache };
}

function publishedStates(events: { publish: ReturnType<typeof vi.fn> }) {
  return events.publish.mock.calls.map(([, payload]) => `${payload.state}:${payload.reason}`);
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

  it('never restarts a relay again after Docker refused recovery, whatever the next failure is', async () => {
    let next = 0;
    const reasons = [new Error('connect refused'), Object.assign(new Error('listener down'), { code: 14 })];
    const getHealth = vi.fn(async () => {
      next += 1;
      if (next % 2) throw reasons[0];
      return { ...healthy(), liveness: false };
    });
    const recover = vi.fn().mockRejectedValue(new RelayRecoverySafetyError('docker_unavailable', 'Docker is down'));
    const { supervisor } = harness({ getHealth, recover });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical' }));
    // The cause now flips between unreachable and listener_unavailable on every probe.
    for (let probe = 0; probe < 6; probe += 1) await supervisor.probeNow();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical', canRetry: true });
  });

  it('waits for a relay someone else just restarted instead of restarting it again', async () => {
    const connectRefused = new Error('connect refused');
    const getHealth = vi
      .fn()
      .mockResolvedValueOnce(healthy())
      .mockRejectedValueOnce(connectRefused)
      .mockRejectedValueOnce(connectRefused)
      .mockRejectedValueOnce(connectRefused)
      .mockResolvedValue(healthy());
    // `docker restart` by an operator: a new run started after the last healthy probe.
    const inspectRelay = vi.fn(async () => ({
      id: 'relay-id',
      running: true,
      startedAt: new Date(Date.now() + 5).toISOString(),
    }));
    const { supervisor, recover, events } = harness({ getHealth, inspectRelay, readinessWaitMs: 60_000 });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 }));
    expect(recover).not.toHaveBeenCalled();
    expect(publishedStates(events)).not.toContain('critical:docker_unavailable');
  });

  it('still restarts a relay whose current run was healthy before it stopped answering', async () => {
    const getHealth = vi
      .fn()
      .mockResolvedValueOnce(healthy())
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue(healthy());
    const inspectRelay = vi.fn().mockResolvedValue({
      id: 'relay-id',
      running: true,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { supervisor, recover } = harness({ getHealth, inspectRelay, readinessWaitMs: 60_000 });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('reports a relay that came back after a failed Docker call as healthy, not docker_unavailable', async () => {
    const getHealth = vi
      .fn()
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockRejectedValueOnce(new Error('connect refused'))
      .mockResolvedValue(healthy());
    const recover = vi.fn().mockRejectedValue(
      new RelayRecoverySafetyError('docker_unavailable', 'Docker relay recovery action failed', {
        cause: new Error('Docker API request timed out'),
      })
    );
    const { supervisor, events } = harness({ getHealth, recover, readinessWaitMs: 60_000 });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', reason: null }));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(publishedStates(events)).not.toContain('critical:docker_unavailable');
  });

  it('keeps the attempt budget across failure causes until the relay recovers or an admin retries', async () => {
    let next = 0;
    const getHealth = vi.fn(async () => {
      next += 1;
      if (next % 2) throw new Error('connect refused');
      return { ...healthy(), liveness: false };
    });
    const { supervisor, recover } = harness({ getHealth });
    await supervisor.probeNow();
    await supervisor.probeNow();
    await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'critical' }));
    expect(recover).toHaveBeenCalledTimes(3);
    for (let probe = 0; probe < 6; probe += 1) await supervisor.probeNow();
    expect(recover).toHaveBeenCalledTimes(3);

    await supervisor.retryRecovery('admin-1');
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(6));
  });

  describe('external restarts of any duration (O1)', () => {
    const T0 = Date.parse('2026-09-28T09:23:45.000Z');
    const OLD_RUN = '2026-09-28T08:43:42.000Z';
    const at = (ms: number) => new Date(T0 + ms).toISOString();

    /** A virtual clock: each sleep advances it, so second-long waits take no real time. */
    function virtualClock() {
      const clock = { t: T0, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
      return clock;
    }

    /**
     * Drives the supervisor the way its 5 s timer does: probes at the given offsets from T0, each
     * after the virtual clock reached it (a recovery cycle in between moves the clock itself).
     */
    async function probeAt(
      supervisor: RelaySupervisorService,
      clock: ReturnType<typeof virtualClock>,
      offsets: number[]
    ) {
      for (const offset of offsets) {
        if (clock.t < T0 + offset) clock.t = T0 + offset;
        await supervisor.probeNow();
      }
    }

    it('waits through a slow external docker restart and never starts the relay a second time', async () => {
      const clock = virtualClock();
      // `docker restart` at +4.08 s: the relay drains for 9.9 s (well past the 5 s the rc.18 fix
      // covered), exits at +13.98 s, the new run starts at +14.0 s and answers from +14.9 s.
      const stopAt = 4_080;
      const newRunAt = 14_000;
      const getHealth = vi.fn(async () => {
        const t = clock.t - T0;
        if (t < stopAt + 100 || t >= newRunAt + 900) return healthy();
        throw new Error('connect refused');
      });
      const inspectRelay = vi.fn(async () => {
        const t = clock.t - T0;
        const events = t >= stopAt ? [{ action: 'kill', timeMs: T0 + stopAt, attributes: { signal: '15' } }] : [];
        if (t < newRunAt - 20)
          return { id: 'relay-id', running: true, startedAt: OLD_RUN, stopTimeoutSeconds: 10, events };
        if (t < newRunAt)
          return { id: 'relay-id', running: false, startedAt: OLD_RUN, finishedAt: at(newRunAt - 20), events };
        return { id: 'relay-id', running: true, startedAt: at(newRunAt), stopTimeoutSeconds: 10, events };
      });
      const { supervisor, recover, audit } = harness({ getHealth, inspectRelay, readinessWaitMs: 20_000, clock });

      // Probes every 5 s: healthy, then suspect at +4.9 s, recovering at +9.9 s (inside the stop).
      await probeAt(supervisor, clock, [0, 4_900, 9_900]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 }));

      expect(recover).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.succeeded' }));
      // It came back as soon as the external run answered, not after a supervisor restart.
      expect(clock.t - T0).toBeLessThan(newRunAt + 2_000);
    });

    it('waits through an external restart whose stop takes as long as Docker allows', async () => {
      const clock = virtualClock();
      // SIGTERM ignored: Docker kills after the 10 s stop timeout, the new run starts right after.
      const stopAt = 1_000;
      const newRunAt = stopAt + 10_050;
      const getHealth = vi.fn(async () => {
        const t = clock.t - T0;
        if (t < stopAt || t >= newRunAt + 3_000) return healthy();
        throw new Error('connect refused');
      });
      const inspectRelay = vi.fn(async () => {
        const t = clock.t - T0;
        const events =
          t >= stopAt + 10_000
            ? [
                { action: 'kill', timeMs: T0 + stopAt, attributes: { signal: '15' } },
                { action: 'kill', timeMs: T0 + stopAt + 10_000, attributes: { signal: '9' } },
              ]
            : t >= stopAt
              ? [{ action: 'kill', timeMs: T0 + stopAt, attributes: { signal: '15' } }]
              : [];
        if (t < newRunAt) return { id: 'relay-id', running: true, startedAt: OLD_RUN, events };
        return { id: 'relay-id', running: true, startedAt: at(newRunAt), events };
      });
      const { supervisor, recover } = harness({ getHealth, inspectRelay, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 1_500, 6_500]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 }));
      expect(recover).not.toHaveBeenCalled();
    });

    it('re-judges instead of acting when the relay was started between its decision and its action', async () => {
      const clock = virtualClock();
      // Docker's event history is unavailable here, so the running old run looks hung; the external
      // restart's new run starts just as recovery is about to restart it.
      const newRunAt = 9_950;
      const getHealth = vi.fn(async () => {
        const t = clock.t - T0;
        if (t < 1_000 || t >= newRunAt + 1_500) return healthy();
        throw new Error('connect refused');
      });
      const inspectRelay = vi.fn(async () =>
        clock.t - T0 < newRunAt
          ? { id: 'relay-id', running: true, startedAt: OLD_RUN }
          : { id: 'relay-id', running: true, startedAt: at(newRunAt) }
      );
      const recover = vi.fn(async (decidedOn: { startedAt: string } | undefined) => {
        clock.t = Math.max(clock.t, T0 + newRunAt);
        // The recovery service compares Docker's current run with the observation it was given.
        return decidedOn && decidedOn.startedAt !== at(newRunAt) ? 'superseded' : 'restart';
      });
      const { supervisor, audit } = harness({ getHealth, inspectRelay, recover, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 4_000, 9_000]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 }));

      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ startedAt: OLD_RUN }));
      expect(audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'relay.recovery.succeeded' }));
    });

    it('leaves a relay alone while Docker restart policy restarts it after a crash', async () => {
      const clock = virtualClock();
      const crashAt = 2_000;
      const newRunAt = crashAt + 3_000;
      const getHealth = vi.fn(async () => {
        const t = clock.t - T0;
        if (t < crashAt || t >= newRunAt + 2_000) return healthy();
        throw new Error('connect refused');
      });
      const inspectRelay = vi.fn(async () =>
        clock.t - T0 < newRunAt
          ? { id: 'relay-id', running: false, restarting: true, startedAt: OLD_RUN, finishedAt: at(crashAt) }
          : { id: 'relay-id', running: true, startedAt: at(newRunAt) }
      );
      const { supervisor, recover } = harness({ getHealth, inspectRelay, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 2_500, 3_000]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy', attempt: 0 }));
      expect(recover).not.toHaveBeenCalled();
    });

    it('still restarts a crashed relay that nobody brings back, at once', async () => {
      const clock = virtualClock();
      let recoveredAt: number | null = null;
      const getHealth = vi.fn(async () => {
        const t = clock.t - T0;
        if (t < 1_000 || (recoveredAt !== null && clock.t >= recoveredAt + 800)) return healthy();
        throw new Error('connect refused');
      });
      // The process died at +1 s and Docker left it down (no restart policy, or it gave up).
      const inspectRelay = vi.fn(async () =>
        recoveredAt === null
          ? { id: 'relay-id', running: false, startedAt: OLD_RUN, finishedAt: at(1_000) }
          : { id: 'relay-id', running: true, startedAt: new Date(recoveredAt).toISOString() }
      );
      const recover = vi.fn(async () => {
        recoveredAt = clock.t;
        return 'start';
      });
      const { supervisor, audit } = harness({ getHealth, inspectRelay, recover, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 1_500, 6_500]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
      // Acted on the recovering probe itself, without waiting.
      expect((recoveredAt ?? 0) - T0).toBe(6_500);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'relay.recovery.succeeded',
          details: expect.objectContaining({ action: 'start' }),
        })
      );
    });

    it('still restarts a hung relay whose run was healthy before, at once', async () => {
      const clock = virtualClock();
      let restartedAt: number | null = null;
      const getHealth = vi.fn(async () => {
        if (clock.t - T0 < 1_000 || (restartedAt !== null && clock.t >= restartedAt + 800)) return healthy();
        throw new Error('deadline exceeded');
      });
      const inspectRelay = vi.fn(async () => ({ id: 'relay-id', running: true, startedAt: OLD_RUN, events: [] }));
      const recover = vi.fn(async () => {
        restartedAt = clock.t;
        return 'restart';
      });
      const { supervisor } = harness({ getHealth, inspectRelay, recover, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 1_500, 6_500]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
      expect(recover).toHaveBeenCalledTimes(1);
      expect((restartedAt ?? 0) - T0).toBe(6_500);
    });

    it('restarts a relay whose external stop hung past its kill deadline', async () => {
      const clock = virtualClock();
      let restartedAt: number | null = null;
      const getHealth = vi.fn(async () => {
        if (clock.t - T0 < 1_000 || (restartedAt !== null && clock.t >= restartedAt + 800)) return healthy();
        throw new Error('connect refused');
      });
      const inspectRelay = vi.fn(async () => ({
        id: 'relay-id',
        running: true,
        startedAt: OLD_RUN,
        stopTimeoutSeconds: 10,
        events: [{ action: 'kill', timeMs: T0 + 1_000, attributes: { signal: '15' } }],
      }));
      const recover = vi.fn(async () => {
        restartedAt = clock.t;
        return 'restart';
      });
      const { supervisor } = harness({ getHealth, inspectRelay, recover, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 1_500, 6_500]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
      expect(recover).toHaveBeenCalledTimes(1);
      // Kill deadline: SIGTERM at +1 s + 10 s stop timeout + 5 s grace.
      expect((restartedAt ?? 0) - T0).toBeGreaterThanOrEqual(16_000);
      expect((restartedAt ?? 0) - T0).toBeLessThan(18_000);
    });

    it('starts a relay an operator stopped once the stop has settled', async () => {
      const clock = virtualClock();
      let startedAt: number | null = null;
      const stoppedAt = 6_000;
      const getHealth = vi.fn(async () => {
        if (clock.t - T0 < 1_000 || (startedAt !== null && clock.t >= startedAt + 800)) return healthy();
        throw new Error('connect refused');
      });
      // `docker stop`: SIGTERM at +1 s, exit at +6 s; nothing starts it again.
      const inspectRelay = vi.fn(async () => {
        const events = [{ action: 'kill', timeMs: T0 + 1_000, attributes: { signal: '15' } }];
        if (startedAt !== null) return { id: 'relay-id', running: true, startedAt: new Date(startedAt).toISOString() };
        if (clock.t - T0 < stoppedAt) return { id: 'relay-id', running: true, startedAt: OLD_RUN, events };
        return { id: 'relay-id', running: false, startedAt: OLD_RUN, finishedAt: at(stoppedAt), events };
      });
      const recover = vi.fn(async () => {
        startedAt = clock.t;
        return 'start';
      });
      const { supervisor } = harness({ getHealth, inspectRelay, recover, readinessWaitMs: 20_000, clock });

      await probeAt(supervisor, clock, [0, 1_500, 5_500]);
      await vi.waitFor(() => expect(supervisor.getSnapshot(true)).toMatchObject({ state: 'healthy' }));
      expect(recover).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({ running: false }));
      expect((startedAt ?? 0) - T0).toBeGreaterThanOrEqual(stoppedAt + 2_000);
      expect((startedAt ?? 0) - T0).toBeLessThan(stoppedAt + 3_500);
    });
  });
});
