import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { RelayRegistryService } from './relay-registry.service.js';

const binding = (id: string, role: string, repository: string, actions: string[]) => ({
  id,
  nodeId: 'node-1',
  role,
  repository,
  actions,
  contextKind: 'availability',
  contextId: 'policy-1',
  generation: 1,
  status: 'active',
});

function service(writable: boolean) {
  const bindings = [
    binding('b1', 'mirror', 'gateway/availability/policy-1/1/3', ['pull', 'push']),
    binding('b2', 'runtime', 'gateway/availability/policy-1/1/2', ['pull']),
  ];
  const db = {
    select: () => ({ from: () => ({ where: async () => bindings }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  const relayPolicy = { ensureInternalRegistryRoutes: vi.fn(async () => undefined), revokeOwner: vi.fn() };
  const dispatch = { sendDockerRegistryBindings: vi.fn(async () => ({ success: true })) };
  const registry = {
    issueToken: vi.fn(async (input: { requested: Array<{ repository: string; actions: string[] }> }) => {
      if (!writable && input.requested.some((grant) => grant.actions.includes('push'))) {
        throw new AppError(503, 'INTERNAL_REGISTRY_NOT_WRITABLE', 'Build admission is paused');
      }
      return {
        token: `token:${input.requested[0]!.repository}:${input.requested[0]!.actions.join('+')}`,
        issuedAt: new Date().toISOString(),
        expiresIn: 120,
      };
    }),
  };
  return {
    relayRegistry: new RelayRegistryService(db as never, relayPolicy as never, dispatch as never, registry as never),
    dispatch,
  };
}

describe('registry binding sync while the registry takes no writes', () => {
  it('renews a grant that may push for pulls only instead of failing every binding of the node', async () => {
    const { relayRegistry, dispatch } = service(false);

    await relayRegistry.syncNode('node-1');

    const [, desired] = dispatch.sendDockerRegistryBindings.mock.calls[0] as unknown as [
      string,
      Array<{ bindingId: string; authorization: string }>,
    ];
    expect(desired.map((entry) => [entry.bindingId, entry.authorization])).toEqual([
      ['b1', 'Bearer token:gateway/availability/policy-1/1/3:pull'],
      ['b2', 'Bearer token:gateway/availability/policy-1/1/2:pull'],
    ]);
  });

  it('grants push again once the registry takes writes', async () => {
    const { relayRegistry, dispatch } = service(true);

    await relayRegistry.syncNode('node-1');

    const [, desired] = dispatch.sendDockerRegistryBindings.mock.calls[0] as unknown as [
      string,
      Array<{ bindingId: string; authorization: string }>,
    ];
    expect(desired[0]!.authorization).toBe('Bearer token:gateway/availability/policy-1/1/3:pull+push');
  });
});
