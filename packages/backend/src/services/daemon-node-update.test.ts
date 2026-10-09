import { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { dispatchNodeDaemonUpdate, resumeQueuedDaemonUpdates } from './daemon-node-update.js';
import {
  DaemonUpdateService,
  LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS,
  lastUpdateConnectionsToRecord,
} from './daemon-update.service.js';
import type { NodeLongTask } from './node-long-tasks.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const BACKUP: NodeLongTask = { kind: 'backup', id: 'run-1', label: 'Backup of orders' };
const BUILD: NodeLongTask = { kind: 'build', id: 'build-1', label: 'Build of acme/web' };

/** One docker node in memory; where clauses are not evaluated (the flows under test run one step at a time). */
function harness(options: { tasks?: NodeLongTask[]; leaseMember?: boolean; metadata?: Record<string, unknown> } = {}) {
  const node = {
    id: NODE_ID,
    type: 'docker',
    daemonVersion: 'v2.12.0',
    capabilities: { architecture: 'amd64' },
    metadata: { ...(options.metadata ?? {}) } as Record<string, unknown>,
  };
  const sqlWrites: SQL[] = [];
  const db = {
    select: () => {
      const query: any = Promise.resolve([node]);
      for (const method of ['from', 'where', 'limit']) query[method] = () => query;
      return query;
    },
    update: () => ({
      set: (values: { metadata?: unknown }) => {
        if (values.metadata instanceof SQL) sqlWrites.push(values.metadata);
        else if (values.metadata) node.metadata = structuredClone(values.metadata as Record<string, unknown>);
        const done: any = Promise.resolve();
        done.returning = async () => [{ id: NODE_ID }];
        return { where: () => done };
      },
    }),
  };
  const service = new DaemonUpdateService(db as never, { RELEASES_API_URL: 'https://releases.invalid' } as never);
  const events: unknown[] = [];
  service.setEventBus({ publish: (_event: string, payload: unknown) => events.push(payload) } as never);
  Object.assign(service, {
    getLatestRelease: async () => ({
      daemonType: 'docker',
      tagName: 'v2.12.1-docker',
      version: 'v2.12.1',
      releaseNotes: null,
      releaseUrl: null,
    }),
    prepareTrustedDaemonUpdate: async () => ({
      downloadUrl: 'https://a.invalid/d',
      checksum: 'c',
      signedManifest: '{}',
    }),
  });
  const sendUpdateDaemonCommand = vi.fn(async () => ({
    accepted: Promise.resolve(),
    result: new Promise<never>(() => undefined),
  }));
  const state = { tasks: options.tasks ?? [], clock: Date.now() };
  const enqueue = vi.fn(async (request: { run: () => Promise<void> }) => request.run());
  const deps = {
    db: db as never,
    daemonUpdateService: service,
    dispatch: { isNodeConnected: () => true, sendUpdateDaemonCommand } as never,
    rollout: { isLeaseMember: async () => options.leaseMember === true, enqueue } as never,
    listLongTasks: async () => state.tasks,
    taskWait: { pollMs: 1, timeoutMs: 30 * 60_000, now: () => state.clock },
  };
  return { node, deps, service, state, sendUpdateDaemonCommand, enqueue, events, sqlWrites };
}

describe('daemon update task wait', () => {
  it('sends at once when the node runs no long task', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness();
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps)).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(node.metadata.updatePhase).toBe('executing');
  });

  it('waits for the long tasks of the node, shows the ones left, and sends once they end', async () => {
    const { deps, node, state, service, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP, BUILD] });
    const result = await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(result).toEqual({ scheduled: true, targetVersion: 'v2.12.1', waitingForTasks: 2 });
    expect(node.metadata.updatePhase).toBe('waiting_for_tasks');
    expect(node.metadata.updateWaitingForTasks).toEqual([BACKUP, BUILD]);
    // Nothing restarted yet: the node takes the commands its tasks need.
    await expect(service.isNodeUpdateInProgress(NODE_ID)).resolves.toBe(false);
    // The metadata deadline outlasts the 30 minute wait.
    expect(Date.parse(String(node.metadata.updateDeadlineAt)) - Date.now()).toBeGreaterThan(30 * 60_000);

    state.tasks = [BUILD];
    await vi.waitFor(() => expect(node.metadata.updateWaitingForTasks).toEqual([BUILD]));
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();

    state.tasks = [];
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updatePhase).toBe('executing');
    expect(node.metadata.updateWaitingForTasks).toBeUndefined();
    expect(node.metadata.updateWarnings).toBeUndefined();
    await expect(service.isNodeUpdateInProgress(NODE_ID)).resolves.toBe(true);
  });

  it('goes ahead after 30 minutes with a warning that the update result keeps', async () => {
    const { deps, node, state, service, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    state.clock += 30 * 60_000;
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual([
      'Updated after waiting 30 min while 1 running task (Backup of orders) still ran',
    ]);

    await expect(service.clearNodeUpdateInProgressOnReconnect(NODE_ID, 'v2.12.1')).resolves.toBe(true);
    expect(node.metadata.updateInProgress).toBeUndefined();
    expect(node.metadata.updateWarnings).toBeUndefined();
    expect(node.metadata.lastUpdate).toEqual({
      targetVersion: 'v2.12.1',
      completedAt: expect.any(String),
      warnings: ['Updated after waiting 30 min while 1 running task (Backup of orders) still ran'],
    });
  });

  it('"update now" ends the wait of a waiting update and keeps why it went ahead', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(sendUpdateDaemonCommand).not.toHaveBeenCalled();

    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
      waitSkipped: true,
    });
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updatePhase).toBe('executing');
    expect(node.metadata.updateNow).toBeUndefined();
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });

  it('"update now" does not wait at all for a new update', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP] });
    await expect(dispatchNodeDaemonUpdate(NODE_ID, deps, { now: true })).resolves.toEqual({
      scheduled: true,
      targetVersion: 'v2.12.1',
    });
    expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1);
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });

  it('waits for tasks first, then for lease peers', async () => {
    const { deps, node, state, enqueue, sendUpdateDaemonCommand } = harness({ tasks: [BACKUP], leaseMember: true });
    const result = await dispatchNodeDaemonUpdate(NODE_ID, deps);
    expect(result.waitingForTasks).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
    state.tasks = [];
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(node.metadata.updatePhase).toBe('executing');
  });

  it('takes a waiting update up again after a Gateway restart, bounded from when its wait began', async () => {
    const startedAt = new Date(Date.now() - 40 * 60_000);
    const { deps, node, sendUpdateDaemonCommand } = harness({
      tasks: [BACKUP],
      metadata: {
        updateInProgress: true,
        updateOperationId: 'before-restart',
        updateTargetVersion: 'v2.12.1',
        updateStartedAt: startedAt.toISOString(),
        updatePhase: 'waiting_for_tasks',
        updateTaskWaitStartedAt: startedAt.toISOString(),
        updateWaitingForTasks: [BACKUP],
        updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(resumeQueuedDaemonUpdates(deps, new Date())).resolves.toBe(1);
    // The 30 minutes ran out during the restart: the update goes ahead with its warning.
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual([
      'Updated after waiting 30 min while 1 running task (Backup of orders) still ran',
    ]);
  });

  it('does not wait for tasks again for an update that was waiting for its lease peers', async () => {
    const { deps, node, sendUpdateDaemonCommand } = harness({
      tasks: [BACKUP],
      leaseMember: true,
      metadata: {
        updateInProgress: true,
        updateOperationId: 'before-restart',
        updateTargetVersion: 'v2.12.1',
        updateStartedAt: new Date(Date.now() - 60_000).toISOString(),
        updatePhase: 'waiting_for_lease_peers',
        updateWarnings: ['Updated on request while 1 running task (Backup of orders) ran'],
        updateDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    await expect(resumeQueuedDaemonUpdates(deps, new Date())).resolves.toBe(1);
    await vi.waitFor(() => expect(sendUpdateDaemonCommand).toHaveBeenCalledTimes(1));
    expect(node.metadata.updateWarnings).toEqual(['Updated on request while 1 running task (Backup of orders) ran']);
  });
});

describe('connections of the last update', () => {
  const report = {
    fromVersion: 'v2.12.0',
    toVersion: 'v2.12.1',
    startedAtUnixMs: 1_800_000_000_000,
    finishedAtUnixMs: 1_800_000_004_000,
    handover: true,
    handedOver: 40,
    kept: 38,
    cut: { raw_stream: 2 },
    pauseP50Ms: 900,
    pauseP99Ms: 1800,
    pauseMaxMs: 2100,
  };

  it('records a final report of the completed update once', async () => {
    const { service, sqlWrites, events } = harness({
      metadata: { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } },
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
    expect(events).toEqual([{ id: NODE_ID, action: 'updated' }]);
    // Later health reports repeat it: no read, no write.
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(false);
    expect(sqlWrites).toHaveLength(1);
  });

  it('keeps the counts by class and pauses, and skips reports already kept or of another update', () => {
    const lastUpdate = { targetVersion: '2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] };
    const connections = lastUpdateConnectionsToRecord({ lastUpdate }, report);
    expect(connections).toEqual({
      fromVersion: 'v2.12.0',
      finishedAtUnixMs: 1_800_000_004_000,
      handover: true,
      handedOver: 40,
      kept: 38,
      cut: { raw_stream: 2 },
      pauseP50Ms: 900,
      pauseP99Ms: 1800,
      pauseMaxMs: 2100,
    });
    expect(lastUpdateConnectionsToRecord({ lastUpdate: { ...lastUpdate, connections } }, report)).toBe('skip');
    expect(lastUpdateConnectionsToRecord({ lastUpdate: { ...lastUpdate, targetVersion: 'v2.12.0' } }, report)).toBe(
      'skip'
    );
    // The daemon reports before Gateway saw it register on the target: try again with the next report.
    expect(lastUpdateConnectionsToRecord({ updateInProgress: true, updateTargetVersion: 'v2.12.1' }, report)).toBe(
      'pending'
    );
  });

  it('waits for the update to complete before it records its report', async () => {
    const { service, sqlWrites, node } = harness({
      metadata: { updateInProgress: true, updateTargetVersion: 'v2.12.1', updatePhase: 'reconnecting' },
    });
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(false);
    node.metadata = { lastUpdate: { targetVersion: 'v2.12.1', completedAt: '2027-01-15T08:00:00.000Z', warnings: [] } };
    await expect(service.recordLastUpdateConnections(NODE_ID, report)).resolves.toBe(true);
    expect(sqlWrites).toHaveLength(1);
  });
});

describe('daemon update reconnect deadline', () => {
  it('waits for the daemon at least as long as its launcher keeps the new daemon on trial', async () => {
    const { service, node } = harness({
      metadata: {
        updateInProgress: true,
        updateOperationId: 'op-1',
        updateTargetVersion: 'v2.12.1',
        updatePhase: 'executing',
      },
    });
    service.trackNodeUpdateCompletion(NODE_ID, 'op-1', Promise.resolve({ commandId: 'c', success: true } as never));
    await vi.waitFor(() => expect(node.metadata.updatePhase).toBe('reconnecting'));
    // A rollback after the launcher's trial (3.5 min) must find the update still waiting, not failed and offline.
    expect(Date.parse(String(node.metadata.updateDeadlineAt)) - Date.now()).toBeGreaterThan(
      LAUNCHER_CANDIDATE_TRIAL_LIMIT_MS + 30_000
    );
  });
});
