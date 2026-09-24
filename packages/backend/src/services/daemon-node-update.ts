import { eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { nodes as nodesTable } from '@/db/schema/nodes.js';
import { AppError } from '@/middleware/error-handler.js';
import { type DaemonUpdateService, daemonTypeForNodeType } from './daemon-update.service.js';
import type { NodeDispatchService } from './node-dispatch.service.js';

export interface NodeDaemonUpdateDeps {
  db: Pick<DrizzleClient, 'select'>;
  daemonUpdateService: DaemonUpdateService;
  dispatch: Pick<NodeDispatchService, 'sendUpdateDaemonCommand'>;
}

/**
 * Sends the latest trusted daemon release to one node. Shared by
 * POST /system/daemon-updates/:nodeId and the AI/MCP system update tool.
 */
export async function dispatchNodeDaemonUpdate(
  nodeId: string,
  deps: NodeDaemonUpdateDeps
): Promise<{ scheduled: true; targetVersion: string }> {
  const { db, daemonUpdateService, dispatch } = deps;
  const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);
  if (!node) throw new AppError(404, 'NODE_NOT_FOUND', 'Node not found');

  const daemonType = daemonTypeForNodeType(node.type);
  if (!daemonType) throw new AppError(400, 'UNSUPPORTED_NODE_TYPE', 'This node does not run an updatable daemon');
  const release = await daemonUpdateService.getLatestRelease(daemonType);
  if (!release) throw new AppError(404, 'RELEASE_NOT_FOUND', 'No release found for this daemon type');

  const arch = (((node.capabilities ?? {}) as Record<string, unknown>).architecture as string) ?? 'amd64';
  const artifact = await daemonUpdateService.prepareTrustedDaemonUpdate(
    daemonType,
    release.tagName,
    release.version,
    arch
  );

  const operationId = await daemonUpdateService.markNodeUpdateInProgress(nodeId, release.version);
  try {
    const command = await dispatch.sendUpdateDaemonCommand(
      nodeId,
      artifact.downloadUrl,
      release.version,
      artifact.checksum,
      artifact.signedManifest
    );
    daemonUpdateService.trackNodeUpdateCompletion(nodeId, operationId, command.result);
    await command.accepted;
  } catch (error) {
    await daemonUpdateService.clearNodeUpdateInProgress(nodeId, operationId);
    throw error;
  }

  return { scheduled: true, targetVersion: release.version };
}
