import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  availabilityArtifactIsReferenced,
  DockerAvailabilityArtifactService,
  deletedDockerArtifactReferences,
} from './docker-availability-artifact.service.js';

function service() {
  return new DockerAvailabilityArtifactService({} as never, {} as never, {} as never, {} as never) as any;
}

describe('DockerAvailabilityArtifactService resource projection', () => {
  it('does not fail logical resource reads when the source-image lookup node is offline', async () => {
    const subject = service();
    subject.dispatch = { sendDockerImageCommand: vi.fn().mockRejectedValue(new Error('Node is not connected')) };
    await expect(subject.resolveCanonicalSourceImage('offline-node', 'sha256:abc')).resolves.toBeNull();
  });

  it('still resolves a canonical source tag when the lookup node is available', async () => {
    const subject = service();
    subject.dispatch = {
      sendDockerImageCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([
          { Id: 'sha256:abc', RepoTags: ['127.0.0.1:5443/gateway/availability/p/1/1:image', 'nginx:alpine'] },
        ]),
      }),
    };
    await expect(subject.resolveCanonicalSourceImage('online-node', 'sha256:abc')).resolves.toBe('nginx:alpine');
  });

  it('protects the exact referenced generation without retaining similarly prefixed old generations', () => {
    const repository = 'gateway/availability/policy/1/1';
    expect(availabilityArtifactIsReferenced(repository, { image: `127.0.0.1:5443/${repository}@sha256:abc` })).toBe(
      true
    );
    expect(availabilityArtifactIsReferenced(repository, { yaml: `image: 127.0.0.1:5443/${repository}:image` })).toBe(
      true
    );
    expect(availabilityArtifactIsReferenced(repository, { image: `127.0.0.1:5443/${repository}0@sha256:abc` })).toBe(
      false
    );
  });

  it('does not start collection while a workload operation is active', async () => {
    const subject = service();
    subject.db = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'rollout' }] }) }) })),
    };
    subject.registry = { runGarbageCollection: vi.fn() };
    await subject.collectUnusedArtifacts();
    expect(subject.registry.runGarbageCollection).not.toHaveBeenCalled();
    expect(subject.db.select).toHaveBeenCalledTimes(1);
    expect(subject.collecting).toBe(false);
  });

  it('distinguishes immutable Git builds in one repository and conservatively protects tags', () => {
    const repository = 'gateway/builds/source/web';
    const oldDigest = `sha256:${'a'.repeat(64)}`;
    const newDigest = `sha256:${'b'.repeat(64)}`;
    const refs = { image: `127.0.0.1:5443/${repository}@${newDigest}` };
    expect(availabilityArtifactIsReferenced(repository, refs, oldDigest)).toBe(false);
    expect(availabilityArtifactIsReferenced(repository, refs, newDigest)).toBe(true);
    expect(availabilityArtifactIsReferenced(repository, { image: `${repository}:latest` }, oldDigest)).toBe(true);
  });

  it('removes deleted build and Availability digests from node caches but preserves runtime references', () => {
    const oldDigest = `sha256:${'a'.repeat(64)}`;
    const currentDigest = `sha256:${'b'.repeat(64)}`;
    const availabilityDigest = `sha256:${'c'.repeat(64)}`;
    const artifacts = [
      {
        ownerKind: 'build' as const,
        registryRepository: 'gateway/builds/source/web',
        digest: oldDigest,
      },
      {
        ownerKind: 'build' as const,
        registryRepository: 'gateway/builds/source/web',
        digest: currentDigest,
      },
      {
        ownerKind: 'availability' as const,
        registryRepository: 'gateway/availability/policy/1/1',
        digest: availabilityDigest,
      },
    ];
    const image = {
      RepoTags: ['127.0.0.1:5443/gateway/availability/policy/1/1:image'],
      RepoDigests: [
        `127.0.0.1:5443/gateway/builds/source/web@${oldDigest}`,
        `127.0.0.1:5443/gateway/builds/source/web@${currentDigest}`,
        `127.0.0.1:5443/gateway/availability/policy/1/1@${availabilityDigest}`,
      ],
    };

    expect(
      deletedDockerArtifactReferences(image, artifacts, {
        image: `127.0.0.1:5443/gateway/builds/source/web@${currentDigest}`,
      })
    ).toEqual([
      '127.0.0.1:5443/gateway/availability/policy/1/1:image',
      `127.0.0.1:5443/gateway/builds/source/web@${oldDigest}`,
      `127.0.0.1:5443/gateway/availability/policy/1/1@${availabilityDigest}`,
    ]);
  });

  it.each([
    'removed',
    'stopped',
    'draining',
    'unreachable',
    'cleanup_pending',
  ])('prunes only unreferenced Git digests with a %s placement', async (actualState) => {
    const subject = service();
    const repository = 'gateway/builds/source/web';
    const oldDigest = `sha256:${'a'.repeat(64)}`;
    const newDigest = `sha256:${'b'.repeat(64)}`;
    const chain = (value: unknown) => ({
      from: () => ({ where: async () => value, innerJoin: () => ({ where: async () => value }) }),
    });
    const remove = vi.fn().mockResolvedValue(undefined);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce(chain([{ imageReference: `127.0.0.1:5443/${repository}@${newDigest}` }]))
        .mockReturnValueOnce(chain([{ actualState, imageReference: `127.0.0.1:5443/${repository}@${oldDigest}` }]))
        .mockReturnValueOnce(
          chain([
            { id: 'current', repository, digest: newDigest },
            { id: 'previous', repository, digest: oldDigest },
          ])
        ),
      delete: vi.fn(() => ({ where: remove })),
    };
    await subject.releaseObsoletePins('p');
    if (actualState === 'removed') {
      expect(remove).toHaveBeenCalledOnce();
      expect(new PgDialect().sqlToQuery(remove.mock.calls[0]![0]).params).toEqual(['previous']);
    } else {
      expect(remove).not.toHaveBeenCalled();
    }
  });

  it('retains each Compose service digest independently in a shared repository', async () => {
    const subject = service();
    const repository = 'gateway/builds/source';
    const digests = ['a', 'b', 'c'].map((char) => `sha256:${char.repeat(64)}`);
    const chain = (value: unknown) => ({
      from: () => ({ where: async () => value, innerJoin: () => ({ where: async () => value }) }),
    });
    const remove = vi.fn().mockResolvedValue(undefined);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          chain([
            {
              portableSpec: {
                yaml: `services:\n  web:\n    image: ${repository}@${digests[0]}\n  worker:\n    image: ${repository}@${digests[1]}\n`,
              },
            },
          ])
        )
        .mockReturnValueOnce(chain([]))
        .mockReturnValueOnce(chain(digests.map((digest, index) => ({ id: `pin-${index}`, repository, digest })))),
      delete: vi.fn(() => ({ where: remove })),
    };
    await subject.releaseObsoletePins('p');
    expect(remove).toHaveBeenCalledOnce();
    expect(new PgDialect().sqlToQuery(remove.mock.calls[0]![0]).params).toEqual(['pin-2']);
  });

  it('keeps pins for both current and draining runtime images, but releases unused history', async () => {
    const subject = service();
    const chain = (value: unknown) => ({
      from: () => ({ where: async () => value, innerJoin: () => ({ where: async () => value }) }),
    });
    const remove = vi.fn().mockResolvedValue(undefined);
    subject.db = {
      select: vi
        .fn()
        .mockReturnValueOnce(chain([{ imageReference: 'registry/gateway/availability/p/1/3@sha256:ccc' }]))
        .mockReturnValueOnce(
          chain([{ actualState: 'draining', imageReference: 'registry/gateway/availability/p/1/2@sha256:bbb' }])
        )
        .mockReturnValueOnce(
          chain([
            { id: 'current', repository: 'gateway/availability/p/1/3' },
            { id: 'draining', repository: 'gateway/availability/p/1/2' },
            { id: 'history', repository: 'gateway/availability/p/1/1' },
          ])
        ),
      delete: vi.fn(() => ({ where: remove })),
    };
    await subject.releaseObsoletePins('p');
    expect(remove).toHaveBeenCalledOnce();
    const { params } = new PgDialect().sqlToQuery(remove.mock.calls[0]![0]);
    expect(params).toEqual(['history']);
  });
  it('rewrites a deployment to the mirrored immutable image', () => {
    const subject = service();
    const result = subject.rewriteResource(
      {
        kind: 'deployment',
        reference: { type: 'deployment', deploymentId: 'deployment-1' },
        resourceId: 'deployment-1',
        displayName: 'api',
        currentNodeId: 'node-1',
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'old',
        portableSpec: { desiredConfig: { image: 'example/api:latest', env: { A: '1' } } },
        imageReference: 'example/api:latest',
        running: true,
      },
      new Map([['workload', `127.0.0.1:5443/gateway/availability/p/1/1@sha256:${'a'.repeat(64)}`]])
    );

    expect(result.imageReference).toContain('@sha256:');
    expect(result.portableSpec.desiredConfig).toMatchObject({ env: { A: '1' }, image: result.imageReference });
    expect(result.specFingerprint).not.toBe('old');
  });

  it('rewrites every Compose service and removes build instructions from the placement YAML', () => {
    const subject = service();
    const result = subject.rewriteResource(
      {
        kind: 'compose',
        reference: { type: 'compose', composeProjectId: 'compose-1' },
        resourceId: 'compose-1',
        displayName: 'stack',
        currentNodeId: 'node-1',
        viewScope: 'docker:compose:view',
        manageScope: 'docker:compose:manage',
        specFingerprint: 'old',
        portableSpec: {
          yaml: 'services:\n  api:\n    image: example/api:latest\n    build: .\n  worker:\n    image: example/worker:v1\n',
          normalizedModel: {
            services: {
              api: { image: 'example/api:latest' },
              worker: { image: 'example/worker:v1' },
            },
          },
        },
        composeRevisionId: 'revision-1',
        running: true,
      },
      new Map([
        ['api', `127.0.0.1:5443/gateway/availability/p/1/1@sha256:${'a'.repeat(64)}`],
        ['worker', `127.0.0.1:5443/gateway/availability/p/2/1@sha256:${'b'.repeat(64)}`],
      ])
    );
    const yaml = parse(result.portableSpec.yaml);

    expect(yaml.services.api.image).toContain('@sha256:');
    expect(yaml.services.worker.image).toContain('@sha256:');
    expect(yaml.services.api.build).toBeUndefined();
    expect(result.portableSpec.normalizedModel.services.api.image).toBe(yaml.services.api.image);
    expect(result.portableSpec.configDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps Compose image ordering stable by service name', () => {
    const images = service().resourceImages({
      kind: 'compose',
      portableSpec: { normalizedModel: { services: { worker: { image: 'w' }, api: { image: 'a' } } } },
    });
    expect(images).toEqual([
      { key: 'api', source: 'a' },
      { key: 'worker', source: 'w' },
    ]);
  });

  it('rotates the previous active artifact into a rollback pin only after the new pin exists', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [{ artifactId: 'artifact-old' }] }) }),
      delete: vi.fn(() => ({ where: async () => [] })),
      insert: () => ({
        values: (values: Array<Record<string, unknown>>) => ({
          onConflictDoNothing: async () => {
            inserted.push(...values);
          },
        }),
      }),
    };
    const subject = service();
    subject.db = { transaction: async (callback: (writer: typeof tx) => Promise<void>) => callback(tx) };

    await subject.rotatePins('policy-1', ['artifact-new']);

    expect(inserted).toEqual([
      expect.objectContaining({
        artifactId: 'artifact-old',
        kind: 'rollback',
        ownerKey: 'availability:policy-1',
      }),
    ]);
    expect(tx.delete).toHaveBeenCalledTimes(2);
  });

  it('reuses a ready artifact for healing without mirroring from the unavailable origin node', async () => {
    const subject = service();
    subject.preflight = vi.fn();
    subject.findReusableArtifact = vi.fn().mockResolvedValue({
      id: 'artifact-1',
      reference: `127.0.0.1:5443/gateway/availability/p/1/7@sha256:${'a'.repeat(64)}`,
      repository: 'gateway/availability/p/1/7',
      digest: `sha256:${'a'.repeat(64)}`,
      platform: 'linux/amd64',
      sizeBytes: 123,
    });
    subject.ensurePin = vi.fn();
    subject.rotatePins = vi.fn();
    subject.relayRegistry = { ensureBinding: vi.fn() };
    subject.dispatch = { sendDockerImageCommand: vi.fn().mockResolvedValue({ success: true }) };

    const result = await subject.prepare({
      policyId: 'p',
      generation: 8,
      reuseExistingArtifacts: true,
      resource: {
        kind: 'container',
        reference: { type: 'container', containerId: 'container-1' },
        resourceId: 'container-1',
        displayName: 'api',
        currentNodeId: 'node-origin',
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'old',
        portableSpec: { image: 'example/api:latest' },
        imageReference: 'example/api:latest',
        running: true,
      },
      candidateNodes: [{ id: 'node-2', hostname: 'node-2', slug: 'node-2', compatible: true }],
    });

    expect(subject.findReusableArtifact).toHaveBeenCalledWith('p', 'example/api:latest');
    expect(subject.dispatch.sendDockerImageCommand).toHaveBeenCalledTimes(1);
    expect(subject.dispatch.sendDockerImageCommand).toHaveBeenCalledWith(
      'node-2',
      'ensure',
      { imageRef: `127.0.0.1:5443/gateway/availability/p/1/7@sha256:${'a'.repeat(64)}` },
      expect.any(Number)
    );
    expect(result.imageReference).toContain('/7@sha256:');
  });

  it('mirrors a newly requested image before pre-pulling it onto rollout nodes', async () => {
    const subject = service();
    const calls: string[] = [];
    subject.preflight = vi.fn();
    subject.findReusableArtifact = vi.fn();
    subject.mirrorImage = vi.fn(async () => {
      calls.push('mirror');
      return {
        repository: 'gateway/availability/p/1/9',
        digest: `sha256:${'b'.repeat(64)}`,
        platform: 'linux/amd64',
        sizeBytes: 10,
      };
    });
    subject.recordArtifact = vi.fn().mockResolvedValue('new-artifact');
    subject.ensurePin = vi.fn();
    subject.rotatePins = vi.fn();
    subject.relayRegistry = { ensureBinding: vi.fn() };
    subject.dispatch = {
      sendDockerImageCommand: vi.fn(async () => {
        calls.push('prepull');
        return { success: true };
      }),
    };
    const result = await subject.prepare({
      policyId: 'p',
      generation: 9,
      reuseExistingArtifacts: false,
      resource: {
        kind: 'container',
        currentNodeId: 'origin',
        portableSpec: { image: 'nginx:1.29' },
        imageReference: 'nginx:1.29',
      },
      candidateNodes: [{ id: 'replica', hostname: 'replica' }],
    });
    expect(calls).toEqual(['mirror', 'prepull']);
    expect(subject.findReusableArtifact).not.toHaveBeenCalled();
    expect(subject.mirrorImage).toHaveBeenCalledWith(expect.anything(), { key: 'workload', source: 'nginx:1.29' }, 0);
    expect(result.imageReference).toBe(`127.0.0.1:5443/gateway/availability/p/1/9@sha256:${'b'.repeat(64)}`);
  });

  it('continues preparing healthy candidates when another candidate disconnects', async () => {
    const subject = service();
    subject.preflight = vi.fn();
    subject.findReusableArtifact = vi.fn().mockResolvedValue({
      id: 'artifact-1',
      reference: `127.0.0.1:5443/gateway/availability/p/1/7@sha256:${'a'.repeat(64)}`,
      repository: 'gateway/availability/p/1/7',
      digest: `sha256:${'a'.repeat(64)}`,
      platform: 'linux/amd64',
      sizeBytes: 123,
    });
    subject.ensurePin = vi.fn();
    subject.rotatePins = vi.fn();
    subject.relayRegistry = { ensureBinding: vi.fn() };
    subject.dispatch = {
      sendDockerImageCommand: vi.fn(async (nodeId: string) =>
        nodeId === 'node-offline' ? { success: false, error: 'Node is not connected' } : { success: true }
      ),
    };

    await expect(
      subject.prepare({
        policyId: 'p',
        generation: 8,
        reuseExistingArtifacts: true,
        resource: {
          kind: 'container',
          reference: { type: 'container', containerId: 'container-1' },
          resourceId: 'container-1',
          displayName: 'api',
          currentNodeId: 'node-origin',
          viewScope: 'docker:containers:view',
          manageScope: 'docker:containers:manage',
          specFingerprint: 'old',
          portableSpec: { image: 'example/api:latest' },
          imageReference: 'example/api:latest',
          running: true,
        },
        candidateNodes: [
          { id: 'node-offline', hostname: 'offline', slug: 'offline', compatible: true },
          { id: 'node-online', hostname: 'online', slug: 'online', compatible: true },
        ],
      })
    ).resolves.toMatchObject({ imageReference: expect.stringContaining('@sha256:') });
  });
});
