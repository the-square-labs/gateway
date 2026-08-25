import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import { DockerSourceService } from './docker-source.service.js';

const binding = {
  id: '11111111-1111-4111-8111-111111111111',
  targetKind: 'container',
  nodeId: '22222222-2222-4222-8222-222222222222',
  containerName: 'api',
  deploymentId: null,
  connectorId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
  repositoryRemoteId: '99',
  repositoryFullPath: 'acme/api',
  repositoryCloneUrl: 'https://git.example.test/acme/api.git',
  branch: 'main',
  dockerfilePath: 'Dockerfile',
  contextPath: '.',
  autoBuild: true,
  autoDeploy: true,
  buildArgs: {},
  buildSecretNames: [],
  policy: {},
  desiredCommitSha: null,
  deployedCommitSha: null,
  lastResolvedAt: null,
  lastPollAt: null,
  lastPollError: null,
  webhookConfiguredAt: null,
  webhookProviderId: null,
  lastWebhookAt: null,
  lastWebhookError: null,
  createdById: null,
  updatedById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function allowBusiness(service: DockerSourceService) {
  service.setLicensePolicyService({ requireFeature: vi.fn().mockResolvedValue(undefined) } as never);
  return service;
}

function createHarness(provider: 'gitlab' | 'github' | 'git') {
  const deliveries = new Set<string>();
  const updates: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ binding, provider }]) })),
        })),
        where: vi.fn(() => ({ limit: vi.fn(async () => [binding]) })),
      })),
    })),
    execute: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn((value: { deliveryId: string }) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (deliveries.has(value.deliveryId)) return [];
            deliveries.add(value.deliveryId);
            return [{ id: `delivery-${deliveries.size}`, ...value }];
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn(async () => {
          updates.push(value);
          return [];
        }),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  const service = allowBusiness(
    new DockerSourceService(
      db as never,
      { log: vi.fn() } as never,
      {} as never,
      { deriveScopedSecret: vi.fn(() => 'webhook-secret') } as never
    )
  );
  return { service, updates };
}

function signedHeaders(provider: 'gitlab' | 'github' | 'git', body: Buffer, deliveryId = 'delivery-1') {
  const headers = new Headers();
  if (provider === 'gitlab') {
    headers.set('x-gitlab-token', 'webhook-secret');
    headers.set('x-gitlab-event-uuid', deliveryId);
  } else {
    const signature = createHmac('sha256', 'webhook-secret').update(body).digest('hex');
    headers.set(provider === 'github' ? 'x-hub-signature-256' : 'x-gateway-signature-256', `sha256=${signature}`);
    headers.set(provider === 'github' ? 'x-github-delivery' : 'x-gateway-delivery', deliveryId);
  }
  return headers;
}

describe('DockerSourceService webhooks', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('accepts a signed GitHub push for the exact repository, branch, and SHA and deduplicates replay', async () => {
    const { service, updates } = createHarness('github');
    const body = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: 'a'.repeat(40),
        repository: { id: 99, full_name: 'acme/api' },
      })
    );
    const headers = signedHeaders('github', body);
    const first = await service.handleWebhook(binding.id, headers, body);
    const replay = await service.handleWebhook(binding.id, headers, body);

    expect(first).toMatchObject({ accepted: true, duplicate: false, commitSha: 'a'.repeat(40) });
    expect(replay).toMatchObject({ accepted: true, duplicate: true, deliveryId: 'delivery-1' });
    expect(updates).toHaveLength(1);
  });

  it('rejects an invalid GitHub signature before accepting the delivery', async () => {
    const { service, updates } = createHarness('github');
    const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40), repository: { id: 99 } }));
    await expect(service.handleWebhook(binding.id, new Headers(), body)).rejects.toMatchObject({
      code: 'SOURCE_WEBHOOK_SIGNATURE_INVALID',
    } satisfies Partial<AppError>);
    expect(updates).toHaveLength(0);
  });

  it('validates GitLab token, configured branch, repository identity, and exact SHA', async () => {
    const { service } = createHarness('gitlab');
    const validBody = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: 'b'.repeat(40),
        project: { id: 99, path_with_namespace: 'acme/api' },
      })
    );
    await expect(
      service.handleWebhook(binding.id, signedHeaders('gitlab', validBody), validBody)
    ).resolves.toMatchObject({
      provider: 'gitlab',
      commitSha: 'b'.repeat(40),
    });

    const wrongBranch = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/release',
        after: 'c'.repeat(40),
        project: { id: 99, path_with_namespace: 'acme/api' },
      })
    );
    await expect(
      service.handleWebhook(binding.id, signedHeaders('gitlab', wrongBranch, 'delivery-2'), wrongBranch)
    ).rejects.toMatchObject({ code: 'SOURCE_WEBHOOK_REF_MISMATCH' });

    const wrongRepository = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: 'd'.repeat(40),
        project: { id: 100, path_with_namespace: 'acme/other' },
      })
    );
    await expect(
      service.handleWebhook(binding.id, signedHeaders('gitlab', wrongRepository, 'delivery-3'), wrongRepository)
    ).rejects.toMatchObject({ code: 'SOURCE_WEBHOOK_REPOSITORY_MISMATCH' });
  });

  it('accepts the generic Git HMAC contract and rejects non-immutable refs', async () => {
    const { service } = createHarness('git');
    const validBody = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: 'e'.repeat(40),
        repository: { id: 99, full_name: 'acme/api' },
      })
    );
    await expect(service.handleWebhook(binding.id, signedHeaders('git', validBody), validBody)).resolves.toMatchObject({
      provider: 'git',
      duplicate: false,
    });

    const invalidSha = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'main', repository: { id: 99 } }));
    await expect(
      service.handleWebhook(binding.id, signedHeaders('git', invalidSha, 'delivery-2'), invalidSha)
    ).rejects.toMatchObject({ code: 'SOURCE_WEBHOOK_SHA_INVALID' });
  });

  it('polls GitLab sources with the connector-owned read-only automation scope', async () => {
    const current = { ...binding, desiredCommitSha: 'a'.repeat(40), lastResolvedAt: null };
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([current]) })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ desiredCommitSha: current.desiredCommitSha }]) })),
        })),
      });
    const db = {
      select,
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const integrations = {
      resolveDockerBuildSource: vi.fn().mockResolvedValue({
        provider: 'gitlab',
        remoteId: current.repositoryRemoteId,
        fullPath: current.repositoryFullPath,
        cloneUrl: current.repositoryCloneUrl,
        commitSha: 'b'.repeat(40),
      }),
    };
    const buildService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'build-1' }),
      hasBuildForCommit: vi.fn().mockResolvedValue(false),
    };
    const service = allowBusiness(
      new DockerSourceService(db as never, { log: vi.fn() } as never, integrations as never, {} as never)
    );
    service.setBuildService(buildService as never);

    await expect(service.pollDue(new Date('2026-08-25T00:00:00Z'))).resolves.toEqual({
      checked: 1,
      changed: 1,
      failed: 0,
    });
    expect(integrations.resolveDockerBuildSource).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.arrayContaining(['integrations:gitlab:repo:read', 'integrations:gitlab:system']),
      }),
      expect.objectContaining({ connectorId: current.connectorId, projectId: current.projectId, branch: 'main' })
    );
    expect(buildService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBindingId: current.id, commitSha: 'b'.repeat(40), trigger: 'poll' })
    );
  });

  it('retries polling enqueue when the desired commit has no durable build row', async () => {
    const current = { ...binding, desiredCommitSha: 'b'.repeat(40), lastResolvedAt: null };
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ orderBy: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([current]) })) })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ desiredCommitSha: current.desiredCommitSha }]) })),
        })),
      });
    const db = {
      select,
      execute: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    };
    const integrations = {
      resolveDockerBuildSource: vi.fn().mockResolvedValue({
        provider: 'gitlab',
        remoteId: current.repositoryRemoteId,
        fullPath: current.repositoryFullPath,
        cloneUrl: current.repositoryCloneUrl,
        commitSha: current.desiredCommitSha,
      }),
    };
    const buildService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'build-retried' }),
      hasBuildForCommit: vi.fn().mockResolvedValue(false),
    };
    const service = allowBusiness(
      new DockerSourceService(db as never, { log: vi.fn() } as never, integrations as never, {} as never)
    );
    service.setBuildService(buildService as never);

    await expect(service.pollDue(new Date('2026-08-25T00:00:00Z'))).resolves.toEqual({
      checked: 1,
      changed: 0,
      failed: 0,
    });
    expect(buildService.hasBuildForCommit).toHaveBeenCalledWith(current.id, current.desiredCommitSha);
    expect(buildService.enqueue).toHaveBeenCalledWith({
      sourceBindingId: current.id,
      commitSha: current.desiredCommitSha,
      trigger: 'poll',
    });
  });

  it('removes an automatically managed provider webhook when the source is detached', async () => {
    const deleteWhere = vi.fn(async () => []);
    const audit = { log: vi.fn(async () => undefined) };
    const integrations = { removeDockerSourceWebhook: vi.fn(async () => true) };
    const service = new DockerSourceService(
      { delete: vi.fn(() => ({ where: deleteWhere })) } as never,
      audit as never,
      integrations as never,
      {} as never
    );
    const serviceWithFinder = service as unknown as {
      findByTarget: (
        target: unknown
      ) => Promise<Omit<typeof binding, 'webhookProviderId'> & { webhookProviderId: string | null }>;
    };
    vi.spyOn(serviceWithFinder, 'findByTarget').mockResolvedValue({
      ...binding,
      webhookProviderId: 'github:42',
    });

    await expect(
      service.remove({ kind: 'container', nodeId: binding.nodeId, containerName: binding.containerName }, 'user-1')
    ).resolves.toBe(true);
    expect(integrations.removeDockerSourceWebhook).toHaveBeenCalledWith({
      connectorId: binding.connectorId,
      projectId: binding.projectId,
      providerId: 'github:42',
    });
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ webhookCleanup: 'removed' }) })
    );
  });

  it('rejects source mutation before provider or database side effects when Business is unavailable', async () => {
    const integrations = { resolveDockerBuildSource: vi.fn() };
    const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() };
    const service = new DockerSourceService(db as never, { log: vi.fn() } as never, integrations as never, {} as never);
    service.setLicensePolicyService({
      requireFeature: vi
        .fn()
        .mockRejectedValue(new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'Business required')),
    } as never);

    await expect(
      service.upsert(
        {
          target: { kind: 'container', nodeId: binding.nodeId, containerName: binding.containerName },
          connectorId: binding.connectorId,
          projectId: binding.projectId,
          branch: binding.branch,
          dockerfilePath: binding.dockerfilePath,
          contextPath: binding.contextPath,
          autoBuild: true,
          autoDeploy: true,
          buildArgs: {},
          buildSecretNames: [],
          policy: {},
        },
        { id: 'user-1' } as never
      )
    ).rejects.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(integrations.resolveDockerBuildSource).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
