import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import type { User } from '@/types.js';
import { executeResourceSetupTool } from '../ai/ai.resource-setup-tools.js';
import { parseRetargetAdditionalSecureLink } from './proxy.schemas.js';
import { ProxyService } from './proxy.service.js';
import { ProxySecureLinkService } from './proxy-secure-link.service.js';

const HOST = { id: '11111111-1111-4111-8111-111111111111', type: 'proxy', nodeId: 'nginx-node' } as any;
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const OLD_STORAGE = '33333333-3333-4333-8333-333333333333';
const NEW_STORAGE = '44444444-4444-4444-8444-444444444444';

function activeStorageLink(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    proxyHostId: HOST.id,
    name: 'assets',
    purpose: 'user_managed',
    upstreamKind: 'managed_storage',
    status: 'active',
    generation: 4,
    managedStorageId: OLD_STORAGE,
    sourceNodeId: 'nginx-node',
    dockerNodeId: 'legacy-node',
    dockerContainerPort: 9000,
    dockerHostPort: 9000,
    forwardScheme: 'http',
    targetNetwork: '',
    targetContainer: `managed-storage-${OLD_STORAGE}`,
    ...overrides,
  } as any;
}

const newTarget = {
  nodeId: 'seaweedfs-node',
  network: '',
  container: `managed-storage-${NEW_STORAGE}`,
  applicationPort: 9000,
  targetPort: 9000,
  forwardScheme: 'https' as const,
  managedStorageId: NEW_STORAGE,
};

function linkDb(link: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  let current = { ...link };
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updates.push(values);
      current = { ...current, ...values };
      const result = Object.assign(Promise.resolve(undefined), {
        returning: vi.fn(async () => [{ ...current }]),
      });
      return { where: vi.fn(() => result) };
    }),
  }));
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ id: NEW_STORAGE }]) })) })),
    })),
    update,
  };
  const db = {
    query: { proxyAdditionalSecureLinks: { findFirst: vi.fn(async () => ({ ...current })) } },
    update,
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  };
  return { db, updates, current: () => current };
}

function makeService(link: Record<string, unknown>) {
  const { db, updates, current } = linkDb(link);
  const relayPolicy = {
    ensureManagedStorageProxySecureLink: vi.fn().mockResolvedValue('route-id'),
    revokeOwner: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ProxySecureLinkService(db as never, {} as never, relayPolicy as never, 'connector@sha256:test');
  vi.spyOn(service as any, 'nodesSupportSecureLinks').mockResolvedValue(true);
  vi.spyOn(service as any, 'emitAdditionalState').mockReturnValue(undefined);
  vi.spyOn(service as any, 'syncSourceNode').mockResolvedValue(undefined);
  const resolve = vi.spyOn(service as any, 'resolveAdditionalTarget').mockResolvedValue(newTarget);
  return { service, db, updates, current, relayPolicy, resolve };
}

describe('Additional Secure Link retarget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    container.reset();
  });

  it('moves an active managed storage link to another cluster in place, without deprovisioning it', async () => {
    const { service, updates, relayPolicy, resolve } = makeService(activeStorageLink());
    const probe = vi.spyOn(service as any, 'probeSecureLink').mockResolvedValue({ httpStatus: 403 });
    const deprovision = vi.spyOn(service as any, 'deprovisionAdditionalRuntime');

    const result = await service.retargetAdditional(
      HOST,
      LINK_ID,
      { upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE },
      ['storage:view']
    );

    // The caller's storage access is checked first, then re-resolved under the storage row lock.
    expect(resolve.mock.calls[0]).toEqual([
      { name: 'assets', upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE },
      ['storage:view'],
    ]);
    expect(resolve.mock.calls[1]?.[2]).toBe(false);
    expect(updates[0]).toMatchObject({
      generation: 5,
      managedStorageId: NEW_STORAGE,
      dockerNodeId: 'seaweedfs-node',
      forwardScheme: 'https',
    });
    // The link never leaves `active`, and it is not torn down.
    expect(updates.every((values) => values.status === undefined)).toBe(true);
    expect(deprovision).not.toHaveBeenCalled();
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalled();
    expect(relayPolicy.ensureManagedStorageProxySecureLink).toHaveBeenCalledWith(
      LINK_ID,
      NEW_STORAGE,
      'nginx-node',
      'seaweedfs-node'
    );
    expect(probe).toHaveBeenCalledWith('nginx-node', expect.objectContaining({ linkId: LINK_ID, scheme: 'https' }));
    expect(result).toMatchObject({ id: LINK_ID, name: 'assets', status: 'active', managedStorageId: NEW_STORAGE });
  });

  it('restores the previous cluster when the new one does not answer', async () => {
    const { service, updates, current, relayPolicy } = makeService(activeStorageLink());
    vi.spyOn(service as any, 'probeSecureLink').mockRejectedValue(new Error('probe timed out'));

    await expect(
      service.retargetAdditional(HOST, LINK_ID, { upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE }, [
        'storage:view',
      ])
    ).rejects.toMatchObject({ statusCode: 502, code: 'SECURE_LINK_RETARGET_FAILED' });

    expect(relayPolicy.ensureManagedStorageProxySecureLink.mock.calls.map((call) => call[1])).toEqual([
      NEW_STORAGE,
      OLD_STORAGE,
    ]);
    expect(updates[1]).toMatchObject({
      generation: 6,
      managedStorageId: OLD_STORAGE,
      dockerNodeId: 'legacy-node',
      forwardScheme: 'http',
    });
    expect(current()).toMatchObject({ status: 'active', managedStorageId: OLD_STORAGE });
  });

  it('re-provisions a Docker link with its new target and keeps the link id and name', async () => {
    const dockerLink = activeStorageLink({
      upstreamKind: 'docker_container',
      managedStorageId: null,
      dockerNodeId: 'docker-node',
      dockerContainerName: 'old-app',
      targetContainer: 'old-app',
    });
    const { service, updates, resolve } = makeService(dockerLink);
    resolve.mockResolvedValue({
      nodeId: 'docker-node',
      network: '',
      container: 'new-app',
      applicationPort: 8080,
      targetPort: 8080,
      forwardScheme: 'http',
    });
    const deprovision = vi.spyOn(service as any, 'deprovisionAdditionalRuntime').mockResolvedValue(undefined);
    const provision = vi
      .spyOn(service as any, 'createAdditionalFromExisting')
      .mockResolvedValue({ ...dockerLink, status: 'provisioning' });

    await service.retargetAdditional(
      HOST,
      LINK_ID,
      {
        upstreamKind: 'docker_container',
        dockerNodeId: 'docker-node',
        dockerContainerName: 'new-app',
        dockerContainerPort: 8080,
      },
      []
    );

    expect(deprovision).toHaveBeenCalledWith(expect.objectContaining({ id: LINK_ID }));
    expect(updates.at(-1)).toMatchObject({
      generation: 5,
      status: 'provisioning',
      upstreamKind: 'docker_container',
      dockerContainerName: 'new-app',
      dockerContainerPort: 8080,
      managedStorageId: null,
    });
    expect(provision).toHaveBeenCalledWith(HOST, LINK_ID);
  });

  it('reapplies the Route config when the link scheme changes, and fails the retarget when it cannot', async () => {
    const before = activeStorageLink();
    const after = { ...before, managedStorageId: NEW_STORAGE, forwardScheme: 'https' };
    const restored = { ...before, generation: 6 };
    const run = async (reapplyHostConfig: ReturnType<typeof vi.fn>) => {
      const self = {
        requireManagedProxyHost: vi.fn().mockResolvedValue(HOST),
        secureLinks: {
          listAdditional: vi.fn().mockResolvedValue([before]),
          // Mirrors the service: the Route config is applied for the switched
          // link, and after a failure for the restored one.
          retargetAdditional: vi.fn(async (_host, _id, _input, _scopes, apply: (link: unknown) => Promise<void>) => {
            try {
              await apply(after);
              return after;
            } catch (error) {
              await apply(restored).catch(() => undefined);
              throw error;
            }
          }),
        },
        reapplyHostConfig,
        auditService: { log: vi.fn() },
      };
      const input = {
        upstreamKind: 'managed_storage' as const,
        managedStorageId: NEW_STORAGE,
        forwardScheme: 'http' as const,
      };
      const result = ProxyService.prototype.retargetAdditionalSecureLink.call(
        self as never,
        HOST.id,
        LINK_ID,
        input,
        'user-1',
        []
      );
      return { self, result };
    };

    const ok = await run(vi.fn().mockResolvedValue(HOST));
    await expect(ok.result).resolves.toBe(after);
    expect(ok.self.reapplyHostConfig).toHaveBeenCalledTimes(1);
    expect(ok.self.auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'proxy_host.additional_secure_link.retarget', resourceId: HOST.id })
    );

    const failing = await run(vi.fn().mockRejectedValueOnce(new Error('nginx reload failed')).mockResolvedValue(HOST));
    await expect(failing.result).rejects.toThrow('nginx reload failed');
    // Applied for the new scheme (failed), then again for the restored one.
    expect(failing.self.reapplyHostConfig).toHaveBeenCalledTimes(2);
    expect(failing.self.auditService.log).not.toHaveBeenCalled();
  });

  it('rolls an in-place retarget back when the Route config cannot be applied', async () => {
    const { service, updates, current, relayPolicy } = makeService(activeStorageLink());
    vi.spyOn(service as any, 'probeSecureLink').mockResolvedValue({ httpStatus: 403 });
    const apply = vi.fn().mockRejectedValueOnce(new Error('nginx reload failed')).mockResolvedValue(undefined);

    await expect(
      service.retargetAdditional(
        HOST,
        LINK_ID,
        { upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE },
        ['storage:view'],
        apply
      )
    ).rejects.toMatchObject({ statusCode: 502, code: 'SECURE_LINK_RETARGET_FAILED' });

    expect(relayPolicy.ensureManagedStorageProxySecureLink.mock.calls.map((call) => call[1])).toEqual([
      NEW_STORAGE,
      OLD_STORAGE,
    ]);
    expect(updates[1]).toMatchObject({ managedStorageId: OLD_STORAGE, forwardScheme: 'http' });
    expect(current()).toMatchObject({ status: 'active', managedStorageId: OLD_STORAGE });
    expect(apply.mock.calls.map((call) => call[0].managedStorageId)).toEqual([NEW_STORAGE, OLD_STORAGE]);
  });

  it('validates the retarget body like a create and never takes a new name', () => {
    expect(() => parseRetargetAdditionalSecureLink({ upstreamKind: 'managed_storage' })).toThrow(
      'Select managed storage'
    );
    expect(
      parseRetargetAdditionalSecureLink({
        upstreamKind: 'managed_storage',
        managedStorageId: NEW_STORAGE,
        name: 'renamed',
      })
    ).toEqual({ upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE, forwardScheme: 'http' });
  });

  it('is reachable from the assistant with proxy:edit on the Route', async () => {
    const retargetAdditionalSecureLink = vi.fn().mockResolvedValue({ id: LINK_ID, status: 'active' });
    container.registerInstance(ProxyService, { retargetAdditionalSecureLink } as unknown as ProxyService);
    const args = {
      operation: 'retarget',
      routeId: HOST.id,
      bindingId: LINK_ID,
      upstreamKind: 'managed_storage',
      managedStorageId: NEW_STORAGE,
    };

    await expect(
      executeResourceSetupTool(
        { id: 'user-1', scopes: [`proxy:view:${HOST.id}`] } as User,
        'manage_additional_secure_link',
        args
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    const user = { id: 'user-1', scopes: [`proxy:edit:${HOST.id}`, 'storage:view'] } as User;
    await executeResourceSetupTool(user, 'manage_additional_secure_link', args);
    expect(retargetAdditionalSecureLink).toHaveBeenCalledWith(
      HOST.id,
      LINK_ID,
      expect.objectContaining({ upstreamKind: 'managed_storage', managedStorageId: NEW_STORAGE }),
      'user-1',
      user.scopes
    );
  });
});
