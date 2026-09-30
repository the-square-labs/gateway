import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import { createChildLogger } from '@/lib/logger.js';
import { isNewerVersion, parseSemver } from '@/lib/semver.js';
import { AppError } from '@/middleware/error-handler.js';
import { type DaemonUpdateService, daemonTypeForNodeType } from './daemon-update.service.js';
import type { DaemonUpdateRollout } from './daemon-update-rollout.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';

const logger = createChildLogger('DaemonNodeUpdate');

export interface NodeDaemonUpdateDeps {
  db: Pick<DrizzleClient, 'select'>;
  daemonUpdateService: DaemonUpdateService;
  dispatch: Pick<NodeDispatchService, 'sendUpdateDaemonCommand' | 'isNodeConnected'>;
  /** Sequences restarts of lease members; without it every update is sent at once. */
  rollout?: Pick<DaemonUpdateRollout, 'isLeaseMember' | 'enqueue'>;
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
}

/**
 * Sends the latest trusted daemon release to one node. Shared by
 * POST /system/daemon-updates/:nodeId and the AI/MCP system update tool.
 */
export async function dispatchNodeDaemonUpdate(
  nodeId: string,
  deps: NodeDaemonUpdateDeps
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

  if (!deps.rollout || !(await deps.rollout.isLeaseMember(nodeId))) {
    const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version);
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
  });
  void deps.rollout
    .enqueue({
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
  return { scheduled: true, targetVersion: release.version, leaseSequenced: true };
}

/** Nodes reconnect after a Gateway restart within seconds; queued updates are taken up again after that. */
const QUEUED_UPDATE_RESUME_DELAY_MS = 60_000;

/**
 * Queued updates of lease members live in memory; a Gateway restart (for example the Gateway update itself) takes them
 * up again from the node metadata, so they neither need an operator nor hang until their deadline.
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
  for (const { nodeId, operationId } of queued) {
    if (!(await deps.daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId))) continue;
    try {
      await dispatchNodeDaemonUpdate(nodeId, deps);
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
