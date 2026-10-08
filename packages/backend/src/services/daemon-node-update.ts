import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import { createChildLogger } from '@/lib/logger.js';
import { isNewerVersion, parseSemver } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import {
  type DaemonUpdateService,
  daemonTypeForNodeType,
  NODE_UPDATE_TASK_WAIT_PHASE,
  NODE_UPDATE_TASK_WAIT_TIMEOUT_MS,
} from './daemon-update.service.js';
import type { DaemonUpdateRollout } from './daemon-update-rollout.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';
import { listNodeLongTasks, type NodeLongTask } from './node-long-tasks.js';

const logger = createChildLogger('DaemonNodeUpdate');

/** How often an update that waits for the long tasks of its node looks at them again. */
const NODE_UPDATE_TASK_POLL_MS = 5_000;

export interface NodeDaemonUpdateDeps {
  db: Pick<DrizzleClient, 'select'>;
  daemonUpdateService: DaemonUpdateService;
  dispatch: Pick<NodeDispatchService, 'sendUpdateDaemonCommand' | 'isNodeConnected'>;
  /** Sequences restarts of lease members; without it every update is sent at once. */
  rollout?: Pick<DaemonUpdateRollout, 'isLeaseMember' | 'enqueue'>;
  /** The long tasks running on a node; listNodeLongTasks by default. */
  listLongTasks?: (nodeId: string) => Promise<NodeLongTask[]>;
  /** Timing of the task wait (tests). */
  taskWait?: { pollMs?: number; timeoutMs?: number; now?: () => number };
}

export interface NodeDaemonUpdateOptions {
  /**
   * The operator's confirmed "update now": the update does not wait for the long tasks of the node (they may fail),
   * and an update that already waits for them stops waiting.
   */
  now?: boolean;
  /** What a waiting update carried before a Gateway restart (resumeQueuedDaemonUpdates). */
  resume?: {
    /** When its task wait began: the wait stays bounded across the restart. */
    taskWaitStartedAt?: number;
    /** Its task wait had ended: it does not wait for tasks again. */
    tasksSettled?: boolean;
    warnings?: string[];
  };
}

export interface NodeDaemonUpdateResult {
  scheduled: true;
  targetVersion: string;
  /**
   * The node votes in or is a candidate of an availability policy in lease mode: the update is sent once the other
   * members of those policies have settled (after a 2 s window that orders requests arriving together, standbys
   * first). Until then the node shows `updatePhase: waiting_for_lease_peers` and `updateWaitingFor`.
   */
  leaseSequenced?: true;
  /**
   * Long tasks run on the node (backups, builds, migrations, Docker tasks, storage copies, archive transfers): the
   * update waits for them first, at most 30 minutes, and shows `updatePhase: waiting_for_tasks` and
   * `updateWaitingForTasks` meanwhile.
   */
  waitingForTasks?: number;
  /** "Update now" ended the task wait of an update that was already waiting. */
  waitSkipped?: true;
}

/** Task waits of this process by node: "update now" ends them at once. */
const taskWaits = new Map<string, { operationId: string; controller: AbortController }>();

function describeTasks(tasks: NodeLongTask[]): string {
  const shown = tasks.slice(0, 3).map((task) => task.label);
  const more = tasks.length > shown.length ? `, and ${tasks.length - shown.length} more` : '';
  return `${tasks.length} running task${tasks.length === 1 ? '' : 's'} (${shown.join(', ')}${more})`;
}

function taskKey(tasks: NodeLongTask[]): string {
  return tasks
    .map((task) => `${task.kind}:${task.id}`)
    .sort()
    .join(',');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Waits until the node runs no long task, the wait runs out, or the operator updates now. Returns the warning the
 * update carries when it goes ahead while tasks run, or null once the update no longer waits (expired or replaced).
 */
async function waitForNodeTasks(
  nodeId: string,
  operationId: string,
  deps: NodeDaemonUpdateDeps,
  initial: NodeLongTask[],
  startedAt: number,
  signal: AbortSignal
): Promise<{ warning?: string } | null> {
  const listTasks = deps.listLongTasks ?? ((id: string) => listNodeLongTasks(deps.db, id));
  const pollMs = deps.taskWait?.pollMs ?? NODE_UPDATE_TASK_POLL_MS;
  const timeoutMs = deps.taskWait?.timeoutMs ?? NODE_UPDATE_TASK_WAIT_TIMEOUT_MS;
  const now = deps.taskWait?.now ?? Date.now;
  let tasks = initial;
  let shown = taskKey(tasks);
  for (;;) {
    if (signal.aborted) return { warning: `Updated on request while ${describeTasks(tasks)} ran` };
    const remainingMs = startedAt + timeoutMs - now();
    if (remainingMs <= 0) {
      return {
        warning: `Updated after waiting ${Math.round(timeoutMs / 60_000)} min while ${describeTasks(tasks)} still ran`,
      };
    }
    await sleep(Math.min(pollMs, remainingMs), signal);
    if (signal.aborted) continue;
    tasks = await listTasks(nodeId);
    if (tasks.length === 0) return {};
    const key = taskKey(tasks);
    if (key !== shown) {
      shown = key;
      if (!(await deps.daemonUpdateService.recordNodeUpdateTaskWait(nodeId, operationId, tasks))) return null;
    }
  }
}

/**
 * Sends the latest trusted daemon release to one node. Shared by
 * POST /system/daemon-updates/:nodeId and the AI/MCP system update tool.
 *
 * The update first waits for the long tasks of the node (up to 30 minutes, then it goes ahead and keeps a warning),
 * then for its lease peers, then it is sent. `now` skips the task wait, also of an update that already waits.
 */
export async function dispatchNodeDaemonUpdate(
  nodeId: string,
  deps: NodeDaemonUpdateDeps,
  options: NodeDaemonUpdateOptions = {}
): Promise<NodeDaemonUpdateResult> {
  const { db, daemonUpdateService, dispatch } = deps;
  const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);
  if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');

  const daemonType = daemonTypeForNodeType(node.type);
  if (!daemonType) throw new AppError(400, 'UNSUPPORTED_NODE_TYPE', 'This node does not run an updatable daemon');
  if (daemonType === 'relay') {
    // A relay restart drops every control stream it carries; only the Relay Pool update drains and orders relays.
    throw new AppError(
      409,
      'RELAY_POOL_UPDATE_REQUIRED',
      'Relay nodes update together with the Relay Pool from the Updates settings'
    );
  }
  const metadata = (node.metadata ?? {}) as Record<string, unknown>;
  if (options.now && metadata.updateInProgress === true && metadata.updatePhase === NODE_UPDATE_TASK_WAIT_PHASE) {
    const waiting = await daemonUpdateService.requestNodeUpdateNow(nodeId);
    if (waiting) {
      const taskWait = taskWaits.get(nodeId);
      if (taskWait?.operationId === waiting.operationId) taskWait.controller.abort();
      logger.warn('Daemon update proceeds without waiting for the running tasks of the node', { nodeId });
      return { scheduled: true, targetVersion: waiting.targetVersion, waitSkipped: true };
    }
  }
  if (!dispatch.isNodeConnected(nodeId)) {
    throw new AppError(409, 'NODE_NOT_CONNECTED', 'Node is not connected');
  }
  const release = await daemonUpdateService.getLatestRelease(daemonType);
  if (!release) throw new AppError(404, 'RELEASE_NOT_FOUND', 'No release found for this daemon type');
  // Never a downgrade or a reinstall: the cached release is the next target of the oldest node of this type.
  if (parseSemver(node.daemonVersion ?? '') !== null && !isNewerVersion(release.version, node.daemonVersion!)) {
    throw new AppError(
      409,
      'NO_UPDATE_AVAILABLE',
      `The node already runs ${node.daemonVersion}, which is not older than ${release.version}`
    );
  }

  const arch = (((node.capabilities ?? {}) as Record<string, unknown>).architecture as string) ?? 'amd64';
  const artifact = await daemonUpdateService.prepareTrustedDaemonUpdate(
    daemonType,
    release.tagName,
    release.version,
    arch
  );

  const send = async (operationId: string) => {
    const command = await dispatch.sendUpdateDaemonCommand(
      nodeId,
      artifact.downloadUrl,
      release.version,
      artifact.checksum,
      artifact.signedManifest
    );
    daemonUpdateService.trackNodeUpdateCompletion(nodeId, operationId, command.result);
    await command.accepted;
  };

  const sequence = (operationId: string) => {
    void deps
      .rollout!.enqueue({
        memberId: nodeId,
        onWait: (blockers) => daemonUpdateService.recordNodeUpdateWait(nodeId, operationId, blockers),
        run: async () => {
          if (!(await daemonUpdateService.beginQueuedNodeUpdate(nodeId, operationId))) return;
          try {
            await send(operationId);
          } catch (error) {
            await daemonUpdateService.failNodeUpdate(
              nodeId,
              operationId,
              error instanceof Error ? error.message : String(error)
            );
            throw error;
          }
        },
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Daemon update of a lease member did not start', { nodeId, error: message });
        await daemonUpdateService.failNodeUpdate(nodeId, operationId, message).catch(() => undefined);
      });
  };

  const listTasks = deps.listLongTasks ?? ((id: string) => listNodeLongTasks(db, id));
  const tasks = options.resume?.tasksSettled ? [] : await listTasks(nodeId);
  const warnings = [...(options.resume?.warnings ?? [])];
  if (options.now && tasks.length > 0) warnings.push(`Updated on request while ${describeTasks(tasks)} ran`);

  if (options.now || tasks.length === 0) {
    if (!deps.rollout || !(await deps.rollout.isLeaseMember(nodeId))) {
      const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version, { warnings });
      try {
        await send(operationId);
      } catch (error) {
        await daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId);
        throw error;
      }
      return { scheduled: true, targetVersion: release.version };
    }
    const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version, {
      waitForLeasePeers: true,
      warnings,
    });
    sequence(operationId);
    return { scheduled: true, targetVersion: release.version, leaseSequenced: true };
  }

  const now = deps.taskWait?.now ?? Date.now;
  const taskWaitStartedAt = Math.min(options.resume?.taskWaitStartedAt ?? now(), now());
  const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version, {
    waitForTasks: tasks,
    taskWaitStartedAt,
    warnings,
  });
  const controller = new AbortController();
  taskWaits.set(nodeId, { operationId, controller });
  void waitForNodeTasks(nodeId, operationId, deps, tasks, taskWaitStartedAt, controller.signal)
    .then(async (outcome) => {
      if (!outcome) return;
      if (outcome.warning) logger.warn('Daemon update goes ahead while tasks run on the node', { nodeId, ...outcome });
      const leaseSequenced = !!deps.rollout && (await deps.rollout.isLeaseMember(nodeId));
      const waitEnded = await daemonUpdateService.endNodeUpdateTaskWait(nodeId, operationId, {
        waitForLeasePeers: leaseSequenced,
        warning: outcome.warning,
      });
      if (!waitEnded) return;
      if (leaseSequenced) {
        sequence(operationId);
        return;
      }
      try {
        await send(operationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Daemon update did not start after its task wait', { nodeId, error: message });
        await daemonUpdateService.failNodeUpdate(nodeId, operationId, message);
      }
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Daemon update did not start after its task wait', { nodeId, error: message });
      await daemonUpdateService.failNodeUpdate(nodeId, operationId, message).catch(() => undefined);
    })
    .finally(() => {
      if (taskWaits.get(nodeId)?.operationId === operationId) taskWaits.delete(nodeId);
    });
  return { scheduled: true, targetVersion: release.version, waitingForTasks: tasks.length };
}

/** Nodes reconnect after a Gateway restart within seconds; queued updates are taken up again after that. */
const QUEUED_UPDATE_RESUME_DELAY_MS = 60_000;

/**
 * Waiting updates (for the long tasks of their node, or of lease members for their peers) live in memory; a Gateway
 * restart (for example the Gateway update itself) takes them up again from the node metadata, so they neither need an
 * operator nor hang until their deadline.
 */
export function scheduleQueuedDaemonUpdateResume(
  deps: NodeDaemonUpdateDeps,
  delayMs = QUEUED_UPDATE_RESUME_DELAY_MS,
  processStartedAt = new Date()
): void {
  const timer = setTimeout(() => {
    void resumeQueuedDaemonUpdates(deps, processStartedAt).catch((error) =>
      logger.error('Queued daemon updates could not be resumed', {
        error: error instanceof Error ? error.message : String(error),
      })
    );
  }, delayMs);
  timer.unref?.();
}

export async function resumeQueuedDaemonUpdates(
  deps: NodeDaemonUpdateDeps,
  processStartedAt = new Date()
): Promise<number> {
  // Updates queued by this process are still in its rollout queue; only the ones from before the restart are orphaned.
  const queued = (await deps.daemonUpdateService.listQueuedNodeUpdates()).filter(
    (update) => update.startedAt === null || update.startedAt < processStartedAt
  );
  for (const update of queued) {
    const { nodeId, operationId } = update;
    if (!(await deps.daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId))) continue;
    try {
      // A task wait goes on where it was (bounded from its start); an update past it does not wait for tasks again.
      await dispatchNodeDaemonUpdate(nodeId, deps, {
        now: update.now,
        resume:
          update.phase === NODE_UPDATE_TASK_WAIT_PHASE
            ? { taskWaitStartedAt: update.taskWaitStartedAt ?? undefined, warnings: update.warnings }
            : { tasksSettled: true, warnings: update.warnings },
      });
      logger.info('Queued daemon update taken up again after a Gateway restart', { nodeId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Queued daemon update could not be taken up again', { nodeId, error: message });
      await deps.daemonUpdateService
        .recordNodeUpdateError(nodeId, `The queued update could not resume after a Gateway restart: ${message}`)
        .catch(() => undefined);
    }
  }
  return queued.length;
}
