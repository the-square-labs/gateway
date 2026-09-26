import { describe, expect, it, vi } from 'vitest';
import { dockerAccessResources, dockerDeployments, dockerSourceBindings } from '@/db/schema/index.js';
import { DockerManagementService } from './docker.service.js';
import { assertContainerNameNotReserved } from './docker-access-resource.service.js';

/**
 * A container created from a Git source reserves its name (source binding plus a runtime-less access identity)
 * until its first build. Another container taking the name would adopt that identity: the reservation's creator
 * could then reach it, and the source's first build would replace it with the source's image.
 */

const NODE = 'node-1';

function db(rows: { binding?: { id: string }; identity?: { id: string; runtimeId: string | null } } = {}) {
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: vi
            .fn()
            .mockResolvedValue(
              table === dockerSourceBindings
                ? rows.binding
                  ? [rows.binding]
                  : []
                : table === dockerAccessResources
                  ? rows.identity
                    ? [rows.identity]
                    : []
                  : table === dockerDeployments
                    ? []
                    : []
            ),
        }),
      }),
    })),
  };
}

describe('Git source name reservations', () => {
  it('refuses a name a source binding holds, unless it is that source creating its container', async () => {
    const held = db({ binding: { id: 'binding-1' }, identity: { id: 'reservation-1', runtimeId: '' } });
    await expect(assertContainerNameNotReserved(held as never, NODE, 'api')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NAME_IN_USE',
    });
    await expect(
      assertContainerNameNotReserved(held as never, NODE, 'api', { sourceBindingId: 'binding-2' })
    ).rejects.toMatchObject({ code: 'NAME_IN_USE' });
    await expect(
      assertContainerNameNotReserved(held as never, NODE, 'api', { sourceBindingId: 'binding-1' })
    ).resolves.toBeUndefined();
  });

  it('refuses a name held by a runtime-less reservation and accepts free or live names', async () => {
    await expect(
      assertContainerNameNotReserved(db({ identity: { id: 'reservation-1', runtimeId: null } }) as never, NODE, 'api')
    ).rejects.toMatchObject({ code: 'NAME_IN_USE' });
    await expect(assertContainerNameNotReserved(db() as never, NODE, 'api')).resolves.toBeUndefined();
    await expect(
      assertContainerNameNotReserved(db({ identity: { id: 'live-1', runtimeId: 'runtime-1' } }) as never, NODE, 'api')
    ).resolves.toBeUndefined();
  });

  it('keeps create and duplicate off a reserved name before contacting the daemon', async () => {
    const dispatch = { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '[]' }) };
    const service = new DockerManagementService(
      db({ binding: { id: 'binding-1' }, identity: { id: 'reservation-1', runtimeId: '' } }) as never,
      { log: vi.fn() } as never,
      dispatch as never,
      { getNode: vi.fn().mockReturnValue({ id: NODE }) } as never
    );
    // The name check both create and duplicate run before dispatching.
    const context = (
      service as unknown as {
        containerMutationContext(): {
          assertNameAvailable(nodeId: string, name: string, claim?: unknown, options?: unknown): Promise<void>;
        };
      }
    ).containerMutationContext();

    await expect(context.assertNameAvailable(NODE, 'api')).rejects.toMatchObject({ code: 'NAME_IN_USE' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
    // Only the source's own first activation passes (it then adopts the reservation).
    await expect(
      context.assertNameAvailable(NODE, 'api', undefined, { sourceBindingId: 'binding-1' })
    ).resolves.toBeUndefined();
  });
});
