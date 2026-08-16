import { and, eq } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerManagedVolumes } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NormalizedMountDefinition } from './docker-socket-mount.guard.js';

function mountKey(mount: NormalizedMountDefinition) {
  return `${mount.type}:${mount.source}:${mount.target}:${mount.readOnly ? 'ro' : 'rw'}:${[...(mount.options ?? [])].sort().join(',')}`;
}

export async function assertManagedMountMutation(args: {
  db: DrizzleClient;
  dispatch: NodeDispatchService;
  parseResult(result: { success: boolean; error?: string; detail?: string }): any;
  nodeId: string;
  current: NormalizedMountDefinition[];
  next: NormalizedMountDefinition[];
}) {
  const currentKeys = new Set(args.current.map(mountKey));
  const changed = args.next.filter((mount) => !currentKeys.has(mountKey(mount)));
  for (const mount of changed) {
    if (mount.type === 'bind') {
      throw new AppError(409, 'HOST_BIND_MOUNTS_DISABLED', 'New host bind mounts are not allowed');
    }
    const [managed] = await args.db
      .select({ volumeName: dockerManagedVolumes.volumeName })
      .from(dockerManagedVolumes)
      .where(and(eq(dockerManagedVolumes.nodeId, args.nodeId), eq(dockerManagedVolumes.volumeName, mount.source)))
      .limit(1);
    if (!managed) {
      throw new AppError(
        409,
        'MANAGED_VOLUME_REQUIRED',
        `Volume "${mount.source}" is legacy or unavailable. Migrate it from Volumes before attaching it.`
      );
    }
    const result = await args.dispatch.sendDockerVolumeCommand(args.nodeId, 'inspect', { name: mount.source });
    const volume = args.parseResult(result);
    const driver = String(volume?.Driver ?? volume?.driver ?? '');
    const scope = String(volume?.Scope ?? volume?.scope ?? '');
    const options = volume?.Options ?? volume?.options ?? {};
    if (driver !== 'local' || scope !== 'local' || !options || Object.keys(options).length > 0) {
      throw new AppError(
        409,
        'MANAGED_VOLUME_UNSAFE',
        `Volume "${mount.source}" no longer has the safe local managed-volume configuration`
      );
    }
  }
}
