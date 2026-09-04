import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { dockerBuildArtifacts, dockerComposeProjects, dockerComposeRevisions } from '@/db/schema/index.js';
import {
  addManagedDatabaseBindingToYaml,
  composeBindingSecretKey,
} from '@/modules/docker/compose/compose-managed-bindings.js';
import {
  availabilityContainerRuntimeSpec,
  availabilityPlacementLabels,
  availabilityPlacementOwner,
  canonicalComposeSourceImage,
  DockerComposeAvailabilityAdapter,
  DockerContainerAvailabilityAdapter,
  DockerDeploymentAvailabilityAdapter,
  deploymentPlacementSnapshot,
  isReplaceableStalePlacementContainer,
  ManagedDatabaseAvailabilityProjector,
  placementContainerHasFailedRuntime,
  rewriteComposeSourceImages,
} from './docker-availability.adapters.js';

describe('Container HA asynchronous stop acknowledgement', () => {
  function stoppingFixture() {
    let running = true;
    const dispatch = { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      { deactivate: vi.fn() } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ runtimeIdentity: { containerId: 'runtime' } });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 2, state: 'stopped' });
    adapter.inspectPlacementContainer = vi.fn(async () => ({
      Id: 'runtime',
      Name: '/app',
      State: { Running: running, Status: running ? 'running' : 'exited' },
    }));
    const context = {
      policyId: 'policy',
      placementId: 'placement',
      operationId: 'restart',
      nodeId: 'node',
      generation: 2,
      idempotencyKey: 'restart:stop',
      resource: { currentNodeId: 'node', imageReference: 'nginx:alpine' },
    };
    return {
      adapter,
      context,
      stopped: () => {
        running = false;
      },
    };
  }

  it('does not acknowledge a stopped placement until Docker actually exits', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, context, stopped } = stoppingFixture();
      const operation = adapter.stopPlacement(context);
      await vi.advanceTimersByTimeAsync(2000);
      expect(adapter.daemon).not.toHaveBeenCalled();
      stopped();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(operation).resolves.toMatchObject({ actualState: 'stopped', serving: false });
      expect(adapter.daemon).toHaveBeenCalledWith(context, 'stop', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failed asynchronous stop retryable instead of publishing false completion', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, context } = stoppingFixture();
      const result = expect(adapter.stopPlacement(context)).rejects.toMatchObject({
        code: 'AVAILABILITY_CONTAINER_STOP_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(41_000);
      await result;
      expect(adapter.daemon).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Container disable with a legacy placement fingerprint', () => {
  it.each([
    'valid',
    'wrong-label',
    'different-image',
    'different-command',
    'different-hostname',
    'different-runtime',
    'foreign-owner',
    'foreign-placement',
    'future-generation',
  ])('%s', async (scenario) => {
    const image = `127.0.0.1:5443/gateway/availability/policy/1/10@sha256:${'a'.repeat(64)}`;
    const spec = { image: 'nginx:alpine', cmd: ['nginx'], runtimeProfile: 'default' };
    const preparedFingerprint = createHash('sha256')
      .update(JSON.stringify({ ...spec, image }))
      .digest('hex');
    const projector = { prepare: vi.fn().mockRejectedValue(new Error('VALIDATION_PASSED')) };
    const dispatch = { sendDockerContainerCommand: vi.fn(), sendDockerImageCommand: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi
      .fn()
      .mockResolvedValue({ generation: 10, state: 'active', runtimeIdentity: { containerId: 'recorded-container' } });
    adapter.claimAndFence = vi.fn();
    adapter.inspectPlacementContainer = vi.fn().mockResolvedValue({
      Id: 'recorded-container',
      Name: '/gwav-container-policy-1-place-1',
      Image: `sha256:${'b'.repeat(64)}`,
      HostConfig: { Runtime: scenario === 'different-runtime' ? 'runsc' : 'runc' },
      Config: {
        Image: image,
        Hostname: scenario === 'different-hostname' ? 'other' : '',
        Cmd: scenario === 'different-command' ? ['other'] : ['nginx'],
        Labels: {
          'wiolett.gateway.availability.policy': scenario === 'foreign-owner' ? 'other-policy' : 'policy-1',
          'wiolett.gateway.availability.placement': scenario === 'foreign-placement' ? 'other-placement' : 'place-1',
          'wiolett.gateway.availability.generation': scenario === 'future-generation' ? '12' : '10',
          'wiolett.gateway.availability.spec-fingerprint':
            scenario === 'wrong-label' ? 'untrusted-fingerprint' : preparedFingerprint,
        },
      },
    });
    const context = {
      policyId: 'policy-1',
      placementId: 'place-1',
      operationId: 'op',
      nodeId: 'remote',
      generation: 11,
      idempotencyKey: 'disable-11',
      resource: {
        kind: 'container',
        resourceId: 'app',
        currentNodeId: 'origin',
        displayName: 'app',
        portableSpec: spec,
        sourceImageReference: image,
        specFingerprint: 'old-pre-mirror-fingerprint',
        imageReference: scenario === 'different-image' ? `repo/other@sha256:${'c'.repeat(64)}` : image,
        running: true,
      },
    };
    if (scenario === 'valid') {
      await expect(adapter.adoptPlacementAsSingle(context)).rejects.toThrow('VALIDATION_PASSED');
      expect(projector.prepare).toHaveBeenCalledOnce();
    } else {
      await expect(adapter.adoptPlacementAsSingle(context)).rejects.toMatchObject({
        code: ['foreign-owner', 'foreign-placement', 'future-generation'].includes(scenario)
          ? 'AVAILABILITY_CONTAINER_NAME_CONFLICT'
          : 'AVAILABILITY_SINGLE_ADOPTION_IDENTITY_UNVERIFIED',
      });
      expect(projector.prepare).not.toHaveBeenCalled();
    }
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand).not.toHaveBeenCalled();
  });
});

describe('Compose canonical image boundary', () => {
  const buildDigest = `sha256:${'a'.repeat(64)}`;
  const buildRepository = 'gateway/builds/source/web';
  const buildImage = `127.0.0.1:5443/${buildRepository}@${buildDigest}`;

  function builtCompose(
    configuredImage = buildImage,
    artifact: { repository: string; digest: string; status: string } | null = {
      repository: buildRepository,
      digest: buildDigest,
      status: 'ready',
    },
    running = true
  ) {
    const project = {
      id: 'project',
      nodeId: 'node',
      name: 'git-stack',
      managementState: 'managed',
      activeRevisionId: 'revision',
      desiredState: running ? 'running' : 'stopped',
    };
    const revision = {
      id: 'revision',
      configDigest: 'config',
      variables: { PUBLIC: 'value' },
      secretKeys: ['TOKEN'],
      originalYaml: `services:\n  web:\n    image: ${configuredImage}\n    ports:\n      - "8080:80"\n`,
      normalizedModel: { services: { web: { image: configuredImage } } },
    };
    const queryValues = (condition: any): unknown[] =>
      (condition?.queryChunks ?? []).flatMap((chunk: any) =>
        chunk?.queryChunks ? queryValues(chunk) : chunk?.value !== undefined ? [chunk.value] : []
      );
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => ({
            limit: async () => {
              if (table === dockerComposeProjects) return [project];
              if (table === dockerComposeRevisions) return [revision];
              const values = queryValues(condition);
              if (
                table === dockerBuildArtifacts &&
                artifact &&
                artifact.status === 'ready' &&
                values.includes(artifact.repository) &&
                values.includes(artifact.digest) &&
                values.includes('ready')
              )
                return [{ id: 'artifact' }];
              return [];
            },
          }),
        }),
      })),
    };
    const runtimeImage = `sha256:${'b'.repeat(64)}`;
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify(
          running
            ? [
                {
                  state: 'running',
                  imageId: runtimeImage,
                  labels: { 'com.docker.compose.project': 'git-stack', 'com.docker.compose.service': 'web' },
                },
              ]
            : []
        ),
      }),
      // Unrelated local tags must not replace the authoritative build reference.
      sendDockerImageCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([{ Id: runtimeImage, RepoTags: ['unrelated/app:latest'] }]),
      }),
    };
    const secrets = { getDecryptedMap: vi.fn() };
    const adapter = new DockerComposeAvailabilityAdapter(db as never, dispatch as never, secrets as never);
    return { adapter, dispatch, secrets, revision };
  }

  it.each([
    true,
    false,
  ])('keeps the exact ready Git build digest in the canonical YAML and delivery model (running=%s)', async (running) => {
    const { adapter, dispatch, secrets, revision } = builtCompose(
      buildImage,
      { repository: buildRepository, digest: buildDigest, status: 'ready' },
      running
    );
    const result = await adapter.resolve({ type: 'compose', composeProjectId: 'project' });
    expect(result.portableSpec.yaml).toContain(`image: ${buildImage}`);
    expect((result.portableSpec.normalizedModel as any).services.web.image).toBe(buildImage);
    expect(result.portableSpec.yaml).not.toContain('unrelated/app');
    expect(result.running).toBe(running);
    expect(revision.normalizedModel.services.web.image).toBe(buildImage);
    expect(secrets.getDecryptedMap).not.toHaveBeenCalled();
    expect(dispatch.sendDockerImageCommand.mock.calls.map((call: any[]) => call[1])).toEqual(['list']);
  });

  it.each([
    null,
    { repository: buildRepository, digest: buildDigest, status: 'deleted' },
    { repository: 'gateway/builds/another', digest: buildDigest, status: 'ready' },
    { repository: buildRepository, digest: `sha256:${'c'.repeat(64)}`, status: 'ready' },
  ])('rejects unavailable or mismatched build artifact metadata %#', async (artifact) => {
    const { adapter } = builtCompose(buildImage, artifact);
    await expect(adapter.resolve({ type: 'compose', composeProjectId: 'project' })).rejects.toMatchObject({
      code: 'AVAILABILITY_CANONICAL_IMAGE_UNRESOLVED',
    });
  });

  it.each([
    `127.0.0.1:5443/gateway/availability/policy/1/1@${buildDigest}`,
    `127.0.0.1:5443/gateway/builds/source/web:latest`,
  ])('does not treat an ephemeral mirror or mutable build tag as a ready build digest (%s)', async (reference) => {
    const { adapter, dispatch } = builtCompose(reference);
    dispatch.sendDockerImageCommand.mockResolvedValue({ success: true, detail: '[]' });
    await expect(adapter.resolve({ type: 'compose', composeProjectId: 'project' })).rejects.toMatchObject({
      code: 'AVAILABILITY_CANONICAL_IMAGE_UNRESOLVED',
    });
  });

  it('stops a placement without the remove-orphans flag forbidden by the daemon', async () => {
    const dispatch = { sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }) };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { deactivate: vi.fn(), prepare: vi.fn().mockResolvedValue({}) } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ runtimeIdentity: {} });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 2, state: 'stopped' });
    const result = await adapter.stopPlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 2,
      idempotencyKey: 'stop',
      resource: {
        resourceId: 'project-1',
        displayName: 'stack',
        currentNodeId: 'node-1',
        composeRevisionId: 'revision-1',
        portableSpec: { yaml: 'services: {}' },
      },
    });
    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'node-1',
      'stop',
      expect.objectContaining({ removeOrphans: false })
    );
    expect(result).toMatchObject({ actualState: 'stopped', serving: false });
  });
  it('resolves a user-facing tag from an internal runtime image identity', () => {
    expect(
      canonicalComposeSourceImage(
        [
          {
            Id: `sha256:${'a'.repeat(64)}`,
            RepoTags: ['127.0.0.1:5443/gateway/availability/policy/1/1:image', 'nginx:alpine'],
          },
        ],
        `sha256:${'a'.repeat(64)}`
      )
    ).toBe('nginx:alpine');
  });

  it('rewrites only service image references in the canonical Compose YAML', () => {
    const yaml = rewriteComposeSourceImages(
      'services:\n  web:\n    image: 127.0.0.1:5443/gateway/availability/policy/1/1:image\n    ports:\n      - "8080:80"\n',
      { web: 'nginx:alpine' }
    );
    expect(yaml).toContain('image: nginx:alpine');
    expect(yaml).toContain('8080:80');
    expect(yaml).not.toContain('gateway/availability');
  });
});

const candidate = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'node-a',
  hostname: 'node-a',
  compatible: true,
  rank: 1,
};

describe('Docker Availability adapter preflight', () => {
  it('recognizes placement ownership across daemon inspect key casing', () => {
    const labels = {
      'wiolett.gateway.availability.policy': 'policy-1',
      'wiolett.gateway.availability.placement': 'placement-1',
      'wiolett.gateway.availability.generation': '1',
      'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
    };
    expect(availabilityPlacementOwner({ Config: { Labels: labels } })).toEqual({
      policyId: 'policy-1',
      placementId: 'placement-1',
    });
    expect(availabilityPlacementOwner({ config: { labels } })).toEqual({
      policyId: 'policy-1',
      placementId: 'placement-1',
    });
  });

  it('keeps source image metadata out of Docker create payloads', () => {
    expect(
      availabilityContainerRuntimeSpec({
        image: 'registry.internal/app@sha256:digest',
        sourceImageReference: 'nginx:1.29-alpine',
        cmd: ['nginx'],
      })
    ).toEqual({ image: 'registry.internal/app@sha256:digest', cmd: ['nginx'] });
  });

  it('replaces only an owned placement from the current or an older generation', () => {
    const inspect = {
      Config: {
        Labels: {
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '7',
        },
      },
    };
    expect(
      isReplaceableStalePlacementContainer(inspect, {
        policyId: 'policy-1',
        placementId: 'placement-1',
        generation: 8,
      })
    ).toBe(true);
    expect(
      isReplaceableStalePlacementContainer(inspect, {
        policyId: 'policy-1',
        placementId: 'placement-1',
        generation: 6,
      })
    ).toBe(false);
    expect(
      isReplaceableStalePlacementContainer(inspect, {
        policyId: 'foreign-policy',
        placementId: 'placement-1',
        generation: 8,
      })
    ).toBe(false);
  });

  it('recreates only non-running placement containers with a recorded runtime error', () => {
    expect(
      placementContainerHasFailedRuntime({ State: { Status: 'created', Running: false, Error: 'stale shim' } })
    ).toBe(true);
    expect(placementContainerHasFailedRuntime({ State: { Status: 'created', Running: false, Error: '' } })).toBe(false);
    expect(placementContainerHasFailedRuntime({ State: { Status: 'running', Running: true, Error: 'old' } })).toBe(
      false
    );
  });

  it('keeps the origin container user-visible while hiding remote placement containers', () => {
    const base = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      generation: 2,
      nodeId: 'origin-node',
      resource: { currentNodeId: 'origin-node' },
    };
    expect(availabilityPlacementLabels(base as never, {})).not.toHaveProperty('wiolett.gateway.availability.managed');
    expect(availabilityPlacementLabels({ ...base, nodeId: 'remote-node' } as never, {})).toMatchObject({
      'wiolett.gateway.availability.managed': 'true',
      'wiolett.gateway.availability.policy': 'policy-1',
      'wiolett.gateway.availability.placement': 'placement-1',
      'wiolett.gateway.availability.generation': '2',
    });
  });

  it('uses the direct daemon inspect result for placement readiness', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({ State: { Status: 'running', Running: true } }),
      }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { inspectContainer: vi.fn().mockResolvedValue({ State: { Status: 'created', Running: false } }) } as never,
      {} as never,
      {} as never
    ) as any;

    await expect(adapter.inspectPlacementContainer('node-1', 'container-1')).resolves.toMatchObject({
      State: { Status: 'running', Running: true },
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('node-1', 'inspect', {
      containerId: 'container-1',
    });
  });

  it('keeps an internally mirrored origin stable for drift detection', async () => {
    const mirrored = `127.0.0.1:5443/gateway/availability/policy/1/1@sha256:${'a'.repeat(64)}`;
    const docker = {
      inspectUserContainer: vi.fn().mockResolvedValue({
        Id: 'container-1',
        Name: '/api',
        Image: `sha256:${'b'.repeat(64)}`,
        Config: {
          Image: mirrored,
          Labels: {
            maintainer: 'team',
            'wiolett.gateway.availability.managed': 'true',
            'wiolett.gateway.availability.policy': 'policy-1',
          },
        },
        HostConfig: {},
        State: { Running: true },
      }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      docker as never,
      {} as never,
      {} as never
    );

    const resource = await adapter.resolve({ type: 'container', nodeId: candidate.id, containerName: 'api' });

    expect(resource.imageReference).toBe(mirrored);
    expect(resource.portableSpec.labels).toEqual({ maintainer: 'team' });
    expect(resource.specFingerprint).toBe(
      createHash('sha256').update(JSON.stringify(resource.portableSpec)).digest('hex')
    );
  });

  it('accepts an internally mirrored digest reference during container preflight', async () => {
    const mirrored = `127.0.0.1:5443/gateway/availability/policy/1/1@sha256:${'a'.repeat(64)}`;
    const docker = {
      inspectUserContainer: vi.fn().mockResolvedValue({ Mounts: [], HostConfig: {} }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      docker as never,
      {} as never,
      {} as never
    );

    const result = await adapter.preflight(
      {
        kind: 'container',
        reference: { type: 'container', nodeId: candidate.id, containerName: 'api' },
        resourceId: 'api',
        displayName: 'api',
        currentNodeId: candidate.id,
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'fingerprint',
        portableSpec: {},
        imageReference: mirrored,
        running: true,
      },
      [candidate],
      []
    );

    expect(result.blockers).not.toContainEqual(
      expect.objectContaining({ code: 'AVAILABILITY_ORIGIN_IMAGE_UNVERIFIED' })
    );
  });

  it('uses an authoritative policy snapshot without inspecting the retired origin container', async () => {
    const docker = { inspectUserContainer: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      docker as never,
      {} as never,
      {} as never
    );
    const result = await adapter.preflight(
      {
        kind: 'container',
        reference: { type: 'container', nodeId: candidate.id, containerName: 'api' },
        resourceId: 'api',
        displayName: 'api',
        currentNodeId: candidate.id,
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'fingerprint',
        portableSpec: {},
        imageReference: `registry/api@sha256:${'a'.repeat(64)}`,
        running: true,
        authoritativeSnapshot: true,
      },
      [candidate],
      []
    );
    expect(result.blockers).toEqual([]);
    expect(docker.inspectUserContainer).not.toHaveBeenCalled();
  });

  it('inspects a newly created remote placement before validating ownership labels', async () => {
    const labels = {
      'wiolett.gateway.availability.policy': 'policy-1',
      'wiolett.gateway.availability.placement': 'placement-1',
      'wiolett.gateway.availability.generation': '1',
      'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
    };
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'No such container' })
      .mockResolvedValueOnce({
        success: true,
        detail: JSON.stringify({
          Id: 'container-1',
          Config: { Image: `registry/api@sha256:${'a'.repeat(64)}`, Labels: labels },
          Image: `sha256:${'b'.repeat(64)}`,
          State: { Running: true },
        }),
      });
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'inspect') return inspect();
        if (action === 'create') return { success: true, detail: JSON.stringify({ Id: 'container-1' }) };
        return { success: true };
      }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({});
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 1 });
    adapter.projector = { prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }) };

    await expect(
      adapter.ensurePlacement({
        policyId: 'policy-1',
        placementId: 'placement-1',
        operationId: 'operation-1',
        nodeId: 'remote-node',
        generation: 1,
        idempotencyKey: 'key',
        resource: {
          currentNodeId: 'origin-node',
          displayName: 'api',
          specFingerprint: 'fingerprint',
          portableSpec: { image: `registry/api@sha256:${'a'.repeat(64)}` },
          imageReference: `registry/api@sha256:${'a'.repeat(64)}`,
        },
      })
    ).resolves.toMatchObject({ serving: true });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('persists the verified active slot for a newly created deployment placement', async () => {
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'create') {
          return {
            success: true,
            detail: JSON.stringify({
              activeSlot: 'blue',
              containerId: 'runtime-green',
              slots: { blue: 'runtime-blue', green: 'runtime-green' },
            }),
          };
        }
        return { success: true };
      }),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
      } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({});
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.verifyRuntimeOwnership = vi.fn().mockResolvedValue('green');
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 1, state: 'active' });

    await adapter.ensurePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 1,
      idempotencyKey: 'key',
      resource: {
        kind: 'deployment',
        currentNodeId: 'origin-node',
        resourceId: 'deployment-1',
        displayName: 'api',
        specFingerprint: 'fingerprint',
        portableSpec: {
          activeSlot: 'blue',
          desiredConfig: { image: `registry/api@sha256:${'a'.repeat(64)}`, labels: {} },
          slots: { blue: 'origin-blue', green: 'origin-green' },
        },
        imageReference: `registry/api@sha256:${'a'.repeat(64)}`,
      },
    });

    expect(adapter.daemon).toHaveBeenCalledWith(
      expect.anything(),
      'activate',
      expect.objectContaining({ runtimeIdentity: expect.objectContaining({ activeSlot: 'green' }) })
    );
  });

  it('keeps ownership of a prior deployment generation across image and environment changes', () => {
    const adapter = new DockerDeploymentAvailabilityAdapter({} as never, {} as never, {} as never) as any;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      nodeId: 'remote',
      generation: 2,
      resource: {
        currentNodeId: 'origin',
        specFingerprint: 'new-spec',
        imageReference: `registry/app@sha256:${'b'.repeat(64)}`,
        portableSpec: {},
      },
    };
    const row = {
      image: `registry/app@sha256:${'a'.repeat(64)}`,
      imageId: `sha256:${'a'.repeat(64)}`,
      labels: {
        'wiolett.gateway.deployment.role': 'app',
        'wiolett.gateway.availability.policy': 'policy-1',
        'wiolett.gateway.availability.placement': 'placement-1',
        'wiolett.gateway.availability.generation': '1',
        'wiolett.gateway.availability.spec-fingerprint': 'old-spec',
      },
    };
    expect(adapter.runtimeRowIdentityIsValid(context, row, true)).toBe(true);
    expect(adapter.runtimeRowIdentityIsValid(context, row, false)).toBe(false);
    expect(adapter.runtimeRowIdentityIsValid({ ...context, generation: 1 }, row, true)).toBe(false);
    expect(adapter.runtimeRowIdentityIsValid({ ...context, placementId: 'foreign' }, row, true)).toBe(false);
  });

  it('rejects every container mount while allowing the registry layer to mirror a mutable source reference', async () => {
    const docker = {
      inspectUserContainer: vi.fn().mockResolvedValue({
        Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data' }],
        HostConfig: { Binds: [] },
      }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      docker as never,
      {} as never,
      {} as never
    );
    const result = await adapter.preflight(
      {
        kind: 'container',
        reference: { type: 'container', nodeId: candidate.id, containerName: 'api' },
        resourceId: 'api',
        displayName: 'api',
        currentNodeId: candidate.id,
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'fingerprint',
        portableSpec: {},
        imageReference: `sha256:${'a'.repeat(64)}`,
        running: true,
      },
      [candidate],
      []
    );
    expect(result.blockers.map((issue) => issue.code)).toEqual(['AVAILABILITY_MOUNTS_UNSUPPORTED']);
  });

  it('claims a generation only when the daemon has not already fenced it', async () => {
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    adapter.assertOperationLease = vi.fn();
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 4, state: 'prepared' });
    adapter.daemon = vi.fn();
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 4,
      idempotencyKey: 'claim-4',
      resource: {
        kind: 'container',
        resourceId: 'resource-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'node-1',
        displayName: 'resource-1',
        portableSpec: {},
      },
    };
    await adapter.claimGeneration(context);
    expect(adapter.daemon).not.toHaveBeenCalled();

    adapter.inspectOptional.mockResolvedValue({ generation: 3, state: 'active' });
    await adapter.claimGeneration(context);
    expect(adapter.daemon).toHaveBeenCalledWith(context, 'prepare', { phase: 'claimed' });
  });

  it.each([
    {
      error: 'invalid availability lifecycle transition: stopped -> activate',
      statusCode: 409,
      code: 'AVAILABILITY_LIFECYCLE_TRANSITION_INVALID',
      retryable: false,
    },
    {
      error: 'availability placement "placement-1" resource identity conflicts with persisted state',
      statusCode: 409,
      code: 'AVAILABILITY_DAEMON_IDENTITY_MISMATCH',
      retryable: false,
    },
    {
      error: 'daemon connection temporarily unavailable',
      statusCode: 502,
      code: 'AVAILABILITY_DAEMON_COMMAND_FAILED',
      retryable: true,
    },
  ])('classifies daemon dispatch refusal: $error', async ({ error, statusCode, code, retryable }) => {
    const dispatch = {
      sendDockerAvailabilityCommand: vi.fn().mockResolvedValue({ success: false, error }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 4,
      idempotencyKey: 'activate-4',
      resource: { kind: 'container', resourceId: 'resource-1', specFingerprint: 'fingerprint' },
    };

    await expect(adapter.daemon(context, 'activate')).rejects.toMatchObject({
      name: 'AppError',
      statusCode,
      code,
      message: error,
      details: { retryable },
    });
    expect(dispatch.sendDockerAvailabilityCommand).toHaveBeenCalledExactlyOnceWith(
      'node-1',
      expect.objectContaining({ action: 'activate', placementId: 'placement-1', generation: 4 })
    );
  });

  it('can inspect an older generation for claiming but never accepts it as a mutation fence', async () => {
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 4,
      idempotencyKey: 'claim-4',
      resource: {
        kind: 'container',
        resourceId: 'resource-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'node-1',
        displayName: 'resource-1',
        portableSpec: {},
      },
    };
    const dispatch = {
      sendDockerAvailabilityCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify({
          policyId: context.policyId,
          placementId: context.placementId,
          resourceKind: context.resource.kind,
          resourceId: context.resource.resourceId,
          generation: 3,
          state: 'active',
        }),
      }),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;

    await expect(adapter.daemon(context, 'inspect')).resolves.toMatchObject({ generation: 3 });
    await expect(adapter.fence(context)).rejects.toMatchObject({ code: 'AVAILABILITY_STALE_GENERATION' });
  });

  it('removes a remote container by its deterministic placement name when daemon runtime metadata is absent', async () => {
    const image = `registry/api@sha256:${'a'.repeat(64)}`;
    const dispatch = { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) };
    const projector = { cleanup: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 21, state: 'prepared' });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn();
    adapter.inspectPlacementContainer = vi.fn().mockResolvedValue({
      Name: '/gwav-container-policy-1-placemen',
      Config: {
        Image: image,
        Labels: {
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '20',
          'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
        },
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Image: `sha256:${'b'.repeat(64)}`,
    });
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 21,
      idempotencyKey: 'cleanup-21',
      resource: {
        kind: 'container',
        resourceId: 'resource-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        displayName: 'api',
        portableSpec: { image },
        imageReference: image,
      },
    };

    await adapter.removePlacement(context);

    expect(adapter.inspectPlacementContainer).toHaveBeenCalledWith('remote-node', 'gwav-container-policy-1-placemen');
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('remote-node', 'remove', {
      containerId: 'gwav-container-policy-1-placemen',
      force: true,
    });
    expect(projector.cleanup).toHaveBeenCalledWith(context);
  });

  it('removes a matching canonical container left by an interrupted remote adoption', async () => {
    const image = `registry/api@sha256:${'a'.repeat(64)}`;
    const dispatch = { sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true }) };
    const projector = { cleanup: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 21,
      state: 'prepared',
      runtimeIdentity: { containerId: 'missing-placement-runtime' },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn();
    adapter.inspectPlacementContainer = vi
      .fn()
      .mockRejectedValueOnce(new Error('container not found'))
      .mockResolvedValueOnce({
        Id: 'canonical-container',
        Name: '/api',
        Config: { Image: image, Labels: {} },
        HostConfig: { RestartPolicy: { Name: 'no' } },
      });
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 21,
      idempotencyKey: 'cleanup-interrupted-21',
      resource: {
        kind: 'container',
        resourceId: 'resource-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        displayName: 'api',
        portableSpec: { image, restartPolicy: 'no' },
        imageReference: image,
      },
    };

    await adapter.removePlacement(context);

    expect(adapter.inspectPlacementContainer).toHaveBeenNthCalledWith(1, 'remote-node', 'missing-placement-runtime');
    expect(adapter.inspectPlacementContainer).toHaveBeenNthCalledWith(2, 'remote-node', 'api');
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('remote-node', 'remove', {
      containerId: 'canonical-container',
      force: true,
    });
    expect(projector.cleanup).toHaveBeenCalledWith(context);
  });

  it('never removes a foreign container that occupies a stale rollout placement name', async () => {
    const image = `registry/api@sha256:${'a'.repeat(64)}`;
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      { prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }) } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 3, state: 'active' });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.projector.deactivate = vi.fn();
    adapter.inspectPlacementContainer = vi.fn().mockResolvedValue({
      Id: 'foreign-container',
      Name: '/gwav-container-policy-1-placemen',
      Config: {
        Image: image,
        Labels: {
          'wiolett.gateway.availability.policy': 'foreign-policy',
          'wiolett.gateway.availability.placement': 'foreign-placement',
          'wiolett.gateway.availability.generation': '3',
          'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
        },
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Image: `sha256:${'b'.repeat(64)}`,
    });
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 4,
      idempotencyKey: 'rollout-4',
      resource: {
        kind: 'container',
        resourceId: 'resource-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        displayName: 'api',
        portableSpec: { image },
        imageReference: image,
      },
    };

    await expect(adapter.ensurePlacement(context)).rejects.toMatchObject({
      code: 'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
    });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalledWith('remote-node', 'remove', expect.anything());
  });

  it('deactivates placement dependencies without contacting an unavailable Docker daemon', async () => {
    const dispatch = { sendDockerAvailabilityCommand: vi.fn() };
    const projector = { deactivateUnavailable: vi.fn(), deactivate: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      projector as never
    ) as any;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'node-unavailable:placement-1',
      nodeId: 'node-offline',
      generation: 4,
      idempotencyKey: 'availability:unroute:placement-1:4',
      resource: {
        kind: 'container',
        resourceId: 'api',
        specFingerprint: 'fingerprint',
      },
    };

    await adapter.deactivatePlacementDependencies(context);

    expect(projector.deactivateUnavailable).toHaveBeenCalledWith(context);
    expect(projector.deactivate).not.toHaveBeenCalled();
    expect(dispatch.sendDockerAvailabilityCommand).not.toHaveBeenCalled();
  });

  it('replaces an owned stale origin container when a prior rollout left its runtime ahead of placement state', async () => {
    const oldImage = `registry/api@sha256:${'a'.repeat(64)}`;
    const newImage = `registry/api@sha256:${'b'.repeat(64)}`;
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'create') return { success: true, detail: JSON.stringify({ Id: 'new-container' }) };
        return { success: true };
      }),
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    const staleInspect = {
      Id: 'stale-container',
      Name: '/api',
      Config: {
        Image: oldImage,
        Labels: {
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '4',
          'wiolett.gateway.availability.spec-fingerprint': 'old-fingerprint',
        },
      },
      Image: `sha256:${'c'.repeat(64)}`,
    };
    const currentInspect = {
      Id: 'new-container',
      Name: '/api',
      Config: {
        Image: newImage,
        Labels: {
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '5',
          'wiolett.gateway.availability.spec-fingerprint': 'new-fingerprint',
          'org.opencontainers.image.title': 'whoami',
        },
      },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
      Image: `sha256:${'d'.repeat(64)}`,
      State: { Status: 'running', Running: true },
    };
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 3,
      state: 'active',
      runtimeIdentity: { containerId: 'retired-container' },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 5, state: 'active' });
    adapter.inspectPlacementContainer = vi
      .fn()
      .mockRejectedValueOnce(new Error('container not found'))
      .mockResolvedValueOnce(staleInspect)
      .mockResolvedValueOnce(currentInspect);
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'origin-node',
      generation: 5,
      idempotencyKey: 'rollout-5',
      resource: {
        kind: 'container',
        resourceId: 'api',
        specFingerprint: 'new-fingerprint',
        currentNodeId: 'origin-node',
        displayName: 'api',
        portableSpec: { image: newImage },
        imageReference: newImage,
        running: true,
      },
    };

    await expect(adapter.ensurePlacement(context)).resolves.toMatchObject({ serving: true });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('origin-node', 'remove', {
      containerId: 'stale-container',
      force: true,
    });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith(
      'origin-node',
      'create',
      expect.objectContaining({ configJson: expect.any(String) })
    );
  });

  it.each([
    1, 2,
  ])('updates an adopted origin by its recorded immutable ID, including retry at generation %s', async (priorGeneration) => {
    const oldId = 'a'.repeat(64);
    const image = `registry/api@sha256:${'b'.repeat(64)}`;
    let existing: Record<string, any> | null = {
      Id: oldId,
      Name: '/api',
      Config: { Image: 'registry/api:v1', Labels: {} },
    };
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_node: string, action: string, input: any) => {
        if (action === 'remove') existing = null;
        if (action === 'create') {
          const config = JSON.parse(input.configJson);
          existing = {
            Id: 'c'.repeat(64),
            Name: '/api',
            Image: `sha256:${'d'.repeat(64)}`,
            Config: { Image: config.image, Labels: config.labels },
            State: { Running: true },
          };
          return { success: true, detail: JSON.stringify({ Id: existing.Id }) };
        }
        return { success: true };
      }),
      sendDockerNetworkCommand: vi.fn(),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
        activate: vi.fn(),
        deactivate: vi.fn(),
      } as never
    ) as any;
    adapter.inspectOptional = vi
      .fn()
      .mockResolvedValue({ generation: priorGeneration, state: 'active', runtimeIdentity: { containerId: oldId } });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 2, state: 'active' });
    adapter.inspectPlacementContainer = vi.fn(async () => {
      if (!existing) throw new Error('container not found');
      return existing;
    });
    await expect(
      adapter.ensurePlacement({
        policyId: 'policy-1',
        placementId: 'placement-1',
        nodeId: 'origin-node',
        generation: 2,
        operationId: 'operation-1',
        idempotencyKey: 'rollout-2',
        resource: {
          kind: 'container',
          resourceId: 'api',
          currentNodeId: 'origin-node',
          displayName: 'api',
          portableSpec: { image },
          imageReference: image,
          specFingerprint: 'new-spec',
          running: true,
        },
      })
    ).resolves.toMatchObject({ serving: true });
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('origin-node', 'remove', {
      containerId: oldId,
      force: true,
    });
    expect(existing?.Config.Image).toBe(image);
  });

  it.each([
    'different-id',
    'different-name',
    'foreign-labels',
    'remote-node',
    'missing-recorded-id',
  ])('does not replace an unverified adopted origin: %s', async (conflict) => {
    const id = 'a'.repeat(64);
    const dispatch = { sendDockerContainerCommand: vi.fn() };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      {} as never,
      {} as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
        deactivate: vi.fn(),
      } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 1,
      state: 'active',
      runtimeIdentity: conflict === 'missing-recorded-id' ? {} : { containerId: id },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.inspectPlacementContainer = vi.fn().mockResolvedValue({
      Id: conflict === 'different-id' ? 'b'.repeat(64) : id,
      Name: conflict === 'different-name' ? '/unrelated' : '/api',
      Config: {
        Labels: conflict === 'foreign-labels' ? { 'wiolett.gateway.availability.policy': 'other-policy' } : {},
      },
    });
    await expect(
      adapter.ensurePlacement({
        policyId: 'policy-1',
        placementId: 'placement-1',
        nodeId: conflict === 'remote-node' ? 'remote-node' : 'origin-node',
        generation: 2,
        resource: { currentNodeId: 'origin-node', displayName: 'api', portableSpec: {} },
      })
    ).rejects.toMatchObject({ code: 'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT' });
    expect(dispatch.sendDockerContainerCommand).not.toHaveBeenCalled();
  });

  it.each([
    'dependencies',
    'remove',
  ])('retains adopted origin identity through a real generation claim and failed %s retry', async (failure) => {
    const oldId = 'a'.repeat(64);
    const newId = 'c'.repeat(64);
    const image = `registry/api@sha256:${'b'.repeat(64)}`;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      nodeId: 'origin-node',
      generation: 2,
      operationId: 'operation-1',
      idempotencyKey: 'rollout-2',
      resource: {
        kind: 'container',
        resourceId: 'api',
        currentNodeId: 'origin-node',
        displayName: 'api',
        portableSpec: { image },
        imageReference: image,
        specFingerprint: 'new-spec',
        running: true,
      },
    };
    let persisted: Record<string, any> = {
      generation: 1,
      state: 'active',
      runtimeIdentity: { containerId: oldId, containerName: 'api' },
    };
    let existing: Record<string, any> | null = {
      Id: oldId,
      Name: '/api',
      Config: { Image: 'registry/api:v1', Labels: {} },
    };
    let failRemoval = failure === 'remove';
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_node: string, action: string, input: any) => {
        if (action === 'remove') {
          if (failRemoval) {
            failRemoval = false;
            return { success: false, error: 'transient removal failure' };
          }
          existing = null;
        }
        if (action === 'create') {
          const config = JSON.parse(input.configJson);
          existing = {
            Id: newId,
            Name: '/api',
            Image: `sha256:${'d'.repeat(64)}`,
            Config: { Image: config.image, Labels: config.labels },
            State: { Running: true },
          };
          return { success: true, detail: JSON.stringify({ Id: newId }) };
        }
        return { success: true };
      }),
      sendDockerNetworkCommand: vi.fn(),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
      activate: vi.fn(),
      deactivate: vi.fn(),
    };
    if (failure === 'dependencies') projector.prepare.mockRejectedValueOnce(new Error('transient dependency failure'));
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.assertOperationLease = vi.fn();
    adapter.waitUntilReady = vi.fn();
    // Model the daemon's higher-generation metadata reset, not an inspect mock
    // that keeps returning the old identity regardless of prepare's payload.
    adapter.daemon = vi.fn(async (claim: typeof context, action: string, config: Record<string, any> = {}) => {
      if (action === 'prepare') {
        persisted = {
          generation: claim.generation,
          state: 'prepared',
          runtimeIdentity: config.runtimeIdentity ?? config,
        };
      } else if (action === 'activate') {
        persisted = { generation: claim.generation, state: 'active', runtimeIdentity: config.runtimeIdentity };
      }
      return { ...persisted };
    });
    adapter.inspectPlacementContainer = vi.fn(async () => {
      if (!existing) throw new Error('container not found');
      return existing;
    });

    await expect(adapter.ensurePlacement(context)).rejects.toThrow(/transient/);
    expect(persisted).toMatchObject({ generation: 2, state: 'prepared', runtimeIdentity: { containerId: oldId } });
    expect(existing?.Id).toBe(oldId);
    expect(dispatch.sendDockerContainerCommand.mock.calls.some(([, action]) => action === 'create')).toBe(false);
    await expect(adapter.ensurePlacement(context)).resolves.toMatchObject({ serving: true });
    expect(adapter.daemon.mock.calls.filter(([, action]: any[]) => action === 'prepare')).toEqual([
      [context, 'prepare', { phase: 'claimed', runtimeIdentity: { containerId: oldId, containerName: 'api' } }],
    ]);
    expect(dispatch.sendDockerContainerCommand).toHaveBeenCalledWith('origin-node', 'remove', {
      containerId: oldId,
      force: true,
    });
    expect(existing?.Id).toBe(newId);
    expect(persisted).toMatchObject({ generation: 2, state: 'active', runtimeIdentity: { containerId: newId } });
  });

  it('keeps an initial claim without runtime identity unchanged', async () => {
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    adapter.assertOperationLease = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({});
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 1,
      idempotencyKey: 'claim-1',
      resource: {
        kind: 'container',
        resourceId: 'api',
        specFingerprint: 'spec',
        currentNodeId: 'node-1',
        displayName: 'api',
        portableSpec: {},
      },
    };
    await adapter.claimGeneration(context);
    expect(adapter.daemon.mock.calls).toEqual([
      [context, 'inspect'],
      [context, 'prepare', { phase: 'claimed' }],
    ]);
  });

  it('requires a new placement identity when the daemon has tombstoned the old one', async () => {
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    ) as any;
    adapter.assertOperationLease = vi.fn();
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 6, state: 'removed' });
    adapter.daemon = vi.fn();

    await expect(
      adapter.claimGeneration({
        policyId: 'policy-1',
        placementId: 'placement-1',
        operationId: 'operation-1',
        nodeId: 'node-1',
        generation: 6,
        idempotencyKey: 'claim-6',
        resource: {
          kind: 'container',
          resourceId: 'resource-1',
          specFingerprint: 'fingerprint',
          currentNodeId: 'node-1',
          displayName: 'resource-1',
          portableSpec: {},
        },
      })
    ).rejects.toMatchObject({
      code: 'AVAILABILITY_PLACEMENT_RETIRED',
    });
    expect(adapter.daemon).not.toHaveBeenCalled();
  });

  it('drains a placement directly without preparing away its active lifecycle state', async () => {
    const adapter = new DockerComposeAvailabilityAdapter({} as never, {} as never, {} as never) as any;
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 2, state: 'draining' });

    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'node-1',
      generation: 2,
      idempotencyKey: 'drain-2',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        displayName: 'stack',
        portableSpec: {},
      },
    };
    await adapter.drainPlacement(context, 30);

    expect(adapter.claimGeneration).toHaveBeenCalledWith(context);
    expect(adapter.fence).toHaveBeenCalled();
    expect(adapter.daemon).toHaveBeenCalledOnce();
    expect(adapter.daemon).toHaveBeenCalledWith(context, 'drain', { drainSeconds: 30 });
  });

  it('recreates a missing Compose placement on the origin node during scale-up', async () => {
    const dispatch = {
      sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({
        composeYaml: `services:\n  web:\n    image: registry.example/web@sha256:${'a'.repeat(64)}\n`,
        composeSecrets: {},
      }),
      activate: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.listRuntimeContainers = vi.fn().mockResolvedValue([]);
    adapter.waitUntilReady = vi.fn();
    adapter.runtimeIdentity = vi.fn().mockResolvedValue({
      projectId: 'project-1',
      projectName: 'stack',
      containers: [{ containerId: 'container-1', serviceName: 'web' }],
    });
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 8, state: 'active' });
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'origin-node',
      generation: 8,
      idempotencyKey: 'scale-8',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        composeRevisionId: 'revision-1',
        portableSpec: {
          revisionId: 'revision-1',
          configDigest: 'b'.repeat(64),
          yaml: `services:\n  web:\n    image: registry.example/web@sha256:${'a'.repeat(64)}\n`,
          normalizedModel: {
            services: { web: { image: `registry.example/web@sha256:${'a'.repeat(64)}` } },
          },
          variables: {},
        },
      },
    };

    await expect(adapter.ensurePlacement(context as never)).resolves.toMatchObject({ serving: true });
    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'origin-node',
      'pull_apply',
      expect.objectContaining({ projectName: 'stack', revisionId: 'revision-1' })
    );
  });

  it('resumes partial Compose adoption without reapplying an already valid ordinary project', async () => {
    const dispatch = { sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }) };
    const projector = {
      prepare: vi.fn().mockResolvedValue({ composeYaml: 'services: {}', composeSecrets: {} }),
      prepareFinalAdoption: vi.fn(),
      adopt: vi.fn(),
    };
    const updateWhere = vi.fn().mockResolvedValue([]);
    const adapter = new DockerComposeAvailabilityAdapter(
      { update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })) } as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 7, state: 'active' });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.listRuntimeContainers = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([{ id: 'ordinary' }]);
    adapter.composeRuntimeHasForeignCollision = vi.fn().mockReturnValue(false);
    adapter.composeRuntimeOwnershipIsValid = vi.fn().mockReturnValue(true);
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 8, state: 'single' });

    await adapter.adoptPlacementAsSingle({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'survivor-node',
      generation: 8,
      idempotencyKey: 'disable-8',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        portableSpec: {
          configDigest: 'a'.repeat(64),
          normalizedModel: { services: { web: { image: 'nginx:alpine' } } },
        },
      },
    } as never);

    expect(dispatch.sendDockerComposeCommand).not.toHaveBeenCalledWith(
      'survivor-node',
      'pull_apply',
      expect.anything()
    );
    expect(adapter.waitUntilReady).toHaveBeenCalledWith(
      expect.objectContaining({ resource: expect.objectContaining({ currentNodeId: 'survivor-node' }) })
    );
    expect(adapter.composeRuntimeOwnershipIsValid).toHaveBeenNthCalledWith(
      2,
      [{ id: 'ordinary' }],
      expect.objectContaining({ resource: expect.objectContaining({ currentNodeId: 'survivor-node' }) })
    );
    expect(projector.adopt).toHaveBeenCalledOnce();
  });

  it('re-applies a stale ordinary Compose project during adoption to prevent false drift', async () => {
    const dispatch = { sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }) };
    const projector = {
      prepare: vi.fn().mockResolvedValue({ composeYaml: 'services: {}', composeSecrets: {} }),
      prepareFinalAdoption: vi.fn(),
      adopt: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })) } as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 7, state: 'active' });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.listRuntimeContainers = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'internal' }])
      .mockResolvedValueOnce([{ id: 'ordinary-with-stale-revision' }]);
    adapter.composeRuntimeHasForeignCollision = vi.fn().mockReturnValue(false);
    adapter.composeRuntimeOwnershipIsValid = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 8, state: 'single' });

    await adapter.adoptPlacementAsSingle({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'survivor-node',
      generation: 8,
      idempotencyKey: 'disable-8',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        portableSpec: {
          revisionId: 'revision-1',
          configDigest: 'a'.repeat(64),
          yaml: 'services:\n  web:\n    image: nginx:alpine\n',
          normalizedModel: { services: { web: { image: 'nginx:alpine' } } },
          variables: {},
        },
      },
    } as never);

    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'survivor-node',
      'apply',
      expect.objectContaining({
        projectName: 'stack',
        revisionId: 'revision-1',
        configDigest: 'a'.repeat(64),
      })
    );
  });

  it('re-applies the canonical Compose revision when the origin placement survives', async () => {
    const dispatch = { sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }) };
    const projector = {
      prepare: vi.fn().mockResolvedValue({ composeYaml: 'services: {}', composeSecrets: {} }),
      prepareFinalAdoption: vi.fn(),
      adopt: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })) } as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 7, state: 'active' });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.listRuntimeContainers = vi.fn().mockResolvedValue([{ id: 'origin-ha-runtime' }]);
    adapter.composeRuntimeHasForeignCollision = vi.fn().mockReturnValue(false);
    adapter.composeRuntimeOwnershipIsValid = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 8, state: 'single' });

    await adapter.adoptPlacementAsSingle({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'origin-node',
      generation: 8,
      idempotencyKey: 'disable-8',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        portableSpec: {
          revisionId: 'revision-1',
          configDigest: 'a'.repeat(64),
          yaml: 'services:\n  web:\n    image: nginx:alpine\n',
          normalizedModel: { services: { web: { image: 'nginx:alpine' } } },
          variables: {},
        },
      },
    } as never);

    expect(adapter.listRuntimeContainers).toHaveBeenCalledOnce();
    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'origin-node',
      'apply',
      expect.objectContaining({
        projectName: 'stack',
        revisionId: 'revision-1',
        configDigest: 'a'.repeat(64),
      })
    );
  });

  it('sends the immutable Compose revision when removing a placement', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({ success: true, detail: '[]' }),
      sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }),
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const secrets = { getDecryptedMap: vi.fn().mockResolvedValue({ APP_SECRET: 'secret' }) };
    const projector = {
      prepare: vi.fn().mockResolvedValue({
        composeYaml: 'services:\n  web:\n    image: nginx:alpine\n',
        composeSecrets: { DATABASE_URL: 'postgres://placement' },
      }),
      cleanup: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      secrets as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 2, state: 'draining' });
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn();

    await adapter.removePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      generation: 2,
      idempotencyKey: 'remove-key',
      operationId: 'operation-1',
      nodeId: 'node-1',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        specFingerprint: 'fingerprint',
        currentNodeId: 'origin-node',
        portableSpec: {
          revisionId: 'revision-1',
          configDigest: 'a'.repeat(64),
          yaml: 'services:\n  web:\n    image: nginx:alpine\n',
          normalizedModel: { services: { web: { image: 'nginx:alpine' } } },
          variables: { APP_ENV: 'test' },
        },
      },
    } as never);

    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'node-1',
      'down',
      expect.objectContaining({
        revisionId: 'revision-1',
        configDigest: 'a'.repeat(64),
        normalizedModelJson: JSON.stringify({ services: { web: { image: 'nginx:alpine' } } }),
        variables: { APP_ENV: 'test' },
        secrets: { APP_SECRET: 'secret', DATABASE_URL: 'postgres://placement' },
      })
    );
    expect(projector.cleanup).toHaveBeenCalledOnce();
  });

  it('removes a managed stale Compose revision during rollout cleanup', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([
          {
            id: 'container-1',
            name: 'gwav-compose-policy-1-placement-1-web-1',
            image: `registry.example/old@sha256:${'b'.repeat(64)}`,
            imageId: `sha256:${'c'.repeat(64)}`,
            labels: {
              'com.docker.compose.project': 'gwav-compose-policy-1-placemen',
              'com.docker.compose.service': 'web',
              'wiolett.gateway.compose.managed': 'true',
              'wiolett.gateway.compose.project-id': 'project-1',
              'wiolett.gateway.compose.revision': 'b'.repeat(64),
            },
          },
        ]),
      }),
      sendDockerComposeCommand: vi.fn().mockResolvedValue({ success: true }),
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({}),
      cleanup: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 24, state: 'draining' });
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn();

    await adapter.removePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      generation: 25,
      idempotencyKey: 'remove-key',
      operationId: 'operation-1',
      nodeId: 'node-1',
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        specFingerprint: 'new-fingerprint',
        currentNodeId: 'origin-node',
        portableSpec: {
          revisionId: 'revision-25',
          configDigest: 'a'.repeat(64),
          yaml: `services:\n  web:\n    image: registry.example/new@sha256:${'d'.repeat(64)}\n`,
          normalizedModel: {
            services: { web: { image: `registry.example/new@sha256:${'d'.repeat(64)}` } },
          },
          variables: {},
        },
      },
    } as never);

    expect(dispatch.sendDockerComposeCommand).toHaveBeenCalledWith(
      'node-1',
      'down',
      expect.objectContaining({ projectName: 'gwav-compose-policy-1-placemen' })
    );
    expect(projector.cleanup).toHaveBeenCalledOnce();
  });

  it('rejects Compose projects when any top-level or service volume exists', async () => {
    const adapter = new DockerComposeAvailabilityAdapter({} as never, {} as never, {} as never);
    const result = await adapter.preflight(
      {
        kind: 'compose',
        reference: { type: 'compose', composeProjectId: '22222222-2222-4222-8222-222222222222' },
        resourceId: '22222222-2222-4222-8222-222222222222',
        displayName: 'stack',
        currentNodeId: candidate.id,
        viewScope: 'docker:compose:view',
        manageScope: 'docker:compose:manage',
        specFingerprint: 'digest',
        portableSpec: {
          normalizedModel: {
            services: {
              api: {
                image: `registry.example/api@sha256:${'a'.repeat(64)}`,
                volumes: [{ source: 'data', target: '/data' }],
              },
            },
            volumes: { data: {} },
          },
        },
        running: true,
      },
      [candidate],
      []
    );
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'AVAILABILITY_MOUNTS_UNSUPPORTED' }));
  });

  it('does not treat an existing Availability-owned Compose placement as a name conflict', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([
          {
            labels: {
              'com.docker.compose.project': 'stack',
              'wiolett.gateway.compose.project-id': '22222222-2222-4222-8222-222222222222',
            },
          },
        ]),
      }),
    };
    const adapter = new DockerComposeAvailabilityAdapter({} as never, dispatch as never, {} as never);
    const result = await adapter.preflight(
      {
        kind: 'compose',
        reference: { type: 'compose', composeProjectId: '22222222-2222-4222-8222-222222222222' },
        resourceId: '22222222-2222-4222-8222-222222222222',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        viewScope: 'docker:compose:view',
        manageScope: 'docker:compose:manage',
        specFingerprint: 'digest',
        portableSpec: {
          normalizedModel: {
            services: { api: { image: `registry.example/api@sha256:${'a'.repeat(64)}` } },
          },
        },
        running: true,
      },
      [candidate],
      []
    );
    expect(result.blockers).not.toContainEqual(expect.objectContaining({ code: 'AVAILABILITY_COMPOSE_NAME_CONFLICT' }));
  });

  it('still rejects an unrelated Compose project with the same runtime name', async () => {
    const dispatch = {
      sendDockerContainerCommand: vi.fn().mockResolvedValue({
        success: true,
        detail: JSON.stringify([{ labels: { 'com.docker.compose.project': 'stack' } }]),
      }),
    };
    const adapter = new DockerComposeAvailabilityAdapter({} as never, dispatch as never, {} as never);
    const result = await adapter.preflight(
      {
        kind: 'compose',
        reference: { type: 'compose', composeProjectId: '22222222-2222-4222-8222-222222222222' },
        resourceId: '22222222-2222-4222-8222-222222222222',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        viewScope: 'docker:compose:view',
        manageScope: 'docker:compose:manage',
        specFingerprint: 'digest',
        portableSpec: {
          normalizedModel: {
            services: { api: { image: `registry.example/api@sha256:${'a'.repeat(64)}` } },
          },
        },
        running: true,
      },
      [candidate],
      []
    );
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'AVAILABILITY_COMPOSE_NAME_CONFLICT' }));
  });

  it('reconstructs the full deployment snapshot before rolling an existing placement', async () => {
    const runtime = {
      deploymentId: 'deployment-1',
      routerName: 'placement-router',
      networkName: 'placement-network',
      slots: { blue: 'placement-blue', green: 'placement-green' },
    };
    expect(
      deploymentPlacementSnapshot(
        {
          routerImage: 'nginx:alpine',
          activeSlot: 'blue',
          routes: [{ hostPort: 8080, containerPort: 80 }],
          health: { path: '/' },
        },
        runtime,
        { image: `registry/app@sha256:${'a'.repeat(64)}` },
        { containers: [] },
        { activeSlot: 'green' }
      )
    ).toMatchObject({
      id: 'deployment-1',
      routerName: 'placement-router',
      networkName: 'placement-network',
      activeSlot: 'green',
      slots: [
        { slot: 'blue', containerName: 'placement-blue' },
        { slot: 'green', containerName: 'placement-green' },
      ],
    });

    const commands: Array<{ action: string; payload: Record<string, any> }> = [];
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_nodeId: string, action: string, payload: Record<string, any>) => {
        commands.push({ action, payload });
        if (action === 'inspect') {
          return {
            success: true,
            detail: JSON.stringify({
              containers: [
                {
                  name: 'gwav-deployment-policy-1-placemen-router',
                  state: 'running',
                  imageId: `sha256:${'b'.repeat(64)}`,
                  labels: {
                    'wiolett.gateway.deployment.id': 'deployment-1',
                    'wiolett.gateway.deployment.role': 'router',
                  },
                },
                {
                  name: 'gwav-deployment-policy-1-placemen-green',
                  state: 'running',
                  image: `registry/app@sha256:${'a'.repeat(64)}`,
                  imageId: `sha256:${'a'.repeat(64)}`,
                  labels: {
                    'wiolett.gateway.deployment.id': 'deployment-1',
                    'wiolett.gateway.deployment.role': 'app',
                    'wiolett.gateway.deployment.slot': 'green',
                    'wiolett.gateway.availability.policy': 'policy-1',
                    'wiolett.gateway.availability.placement': 'placement-1',
                    'wiolett.gateway.availability.generation': '2',
                    'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
                  },
                },
              ],
            }),
          };
        }
        if (action === 'switch') return { success: true, detail: JSON.stringify({ activeSlot: 'blue' }) };
        return { success: true };
      }),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
        cleanup: vi.fn(),
      } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 1,
      runtimeIdentity: { activeSlot: 'green' },
    });
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 2 });

    await adapter.ensurePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 2,
      idempotencyKey: 'key',
      resource: {
        kind: 'deployment',
        currentNodeId: 'origin-node',
        resourceId: 'deployment-1',
        displayName: 'app',
        specFingerprint: 'fingerprint',
        portableSpec: {
          desiredConfig: { image: `registry/app@sha256:${'a'.repeat(64)}` },
          routerImage: 'nginx:alpine',
          activeSlot: 'blue',
          routes: [{ hostPort: 8080, containerPort: 80 }],
          health: { path: '/' },
          slots: { blue: 'origin-blue', green: 'origin-green' },
        },
        imageReference: `registry/app@sha256:${'a'.repeat(64)}`,
      },
    });

    const deploy = commands.find((command) => command.action === 'deploy_slot');
    const deployConfig = JSON.parse(String(deploy?.payload.configJson));
    expect(deployConfig.toSlot).toBe('blue');
    expect(deployConfig.deployment.slots).toEqual([
      { slot: 'blue', containerName: 'gwav-deployment-policy-1-placemen-blue' },
      { slot: 'green', containerName: 'gwav-deployment-policy-1-placemen-green' },
    ]);

    commands.length = 0;
    adapter.inspectOptional.mockResolvedValue({ generation: 3, state: 'active' });
    await adapter.removePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-2',
      nodeId: 'remote-node',
      generation: 3,
      idempotencyKey: 'remove-key',
      resource: {
        kind: 'deployment',
        currentNodeId: 'origin-node',
        resourceId: 'deployment-1',
        displayName: 'app',
        specFingerprint: 'fingerprint',
        portableSpec: {
          desiredConfig: { image: `registry/app@sha256:${'a'.repeat(64)}` },
          routerImage: 'nginx:alpine',
          activeSlot: 'blue',
          routes: [],
          health: {},
          slots: { blue: 'origin-blue', green: 'origin-green' },
        },
      },
    });
    const remove = commands.find((command) => command.action === 'remove');
    const removeConfig = JSON.parse(String(remove?.payload.configJson));
    expect(removeConfig.deployment).toMatchObject({
      routerName: 'gwav-deployment-policy-1-placemen-router',
      networkName: 'gwav-deployment-policy-1-placemen-net',
      slots: [
        { slot: 'blue', containerName: 'gwav-deployment-policy-1-placemen-blue' },
        { slot: 'green', containerName: 'gwav-deployment-policy-1-placemen-green' },
      ],
    });
  });

  it('allows only fully matched pre-label deployment runtimes to be removed during upgrade cleanup', () => {
    const image = `registry/app@sha256:${'a'.repeat(64)}`;
    const adapter = new DockerDeploymentAvailabilityAdapter({} as never, {} as never, {} as never, {} as never) as any;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 9,
      idempotencyKey: 'cleanup-9',
      resource: {
        kind: 'deployment',
        currentNodeId: 'origin-node',
        resourceId: 'deployment-1',
        displayName: 'app',
        specFingerprint: 'fingerprint',
        portableSpec: { desiredConfig: { image } },
        imageReference: image,
      },
    };
    const runtime = {
      deploymentId: 'deployment-1',
      routerName: 'gwav-deployment-policy-1-placemen-router',
      networkName: 'gwav-deployment-policy-1-placemen-net',
      slots: {
        blue: 'gwav-deployment-policy-1-placemen-blue',
        green: 'gwav-deployment-policy-1-placemen-green',
      },
    };
    const rows = [
      {
        name: runtime.routerName,
        imageId: `sha256:${'b'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.managed': 'true',
          'wiolett.gateway.deployment.role': 'router',
        },
      },
      {
        name: runtime.slots.blue,
        image,
        imageId: `sha256:${'b'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.managed': 'true',
          'wiolett.gateway.deployment.role': 'app',
          'wiolett.gateway.deployment.slot': 'blue',
        },
      },
    ];

    expect(adapter.runtimeRemovalOwnershipIsValid(context, rows, runtime)).toBe(true);
    expect(
      adapter.runtimeRemovalOwnershipIsValid(
        context,
        [
          rows[0],
          {
            ...rows[1],
            labels: { ...rows[1].labels, 'wiolett.gateway.availability.policy': 'another-policy' },
          },
        ],
        runtime
      )
    ).toBe(false);

    expect(
      adapter.runtimeRemovalOwnershipIsValid(
        {
          ...context,
          generation: 10,
          resource: {
            ...context.resource,
            specFingerprint: 'new-fingerprint',
            imageReference: `registry/app@sha256:${'c'.repeat(64)}`,
          },
        },
        [
          rows[0],
          {
            ...rows[1],
            image: `registry/app@sha256:${'a'.repeat(64)}`,
            labels: {
              ...rows[1].labels,
              'wiolett.gateway.availability.policy': 'policy-1',
              'wiolett.gateway.availability.placement': 'placement-1',
              'wiolett.gateway.availability.generation': '9',
              'wiolett.gateway.availability.spec-fingerprint': 'old-fingerprint',
            },
          },
        ],
        runtime
      )
    ).toBe(true);
  });

  it('recreates a partial deployment runtime instead of activating or rolling it out', async () => {
    let inspectRows: Array<Record<string, unknown>> = [
      {
        name: 'gwav-deployment-policy-1-placemen-router',
        state: 'created',
        imageId: `sha256:${'b'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.role': 'router',
        },
      },
      {
        name: 'gwav-deployment-policy-1-placemen-blue',
        state: 'running',
        image: `registry/app@sha256:${'a'.repeat(64)}`,
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.role': 'app',
          'wiolett.gateway.deployment.slot': 'blue',
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '3',
          'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
        },
      },
    ];
    const actions: string[] = [];
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_nodeId: string, action: string) => {
        actions.push(action);
        if (action === 'inspect') {
          return { success: true, detail: JSON.stringify({ containers: inspectRows }) };
        }
        if (action === 'create') {
          inspectRows = [
            {
              name: 'gwav-deployment-policy-1-placemen-router',
              state: 'running',
              imageId: `sha256:${'b'.repeat(64)}`,
              labels: {
                'wiolett.gateway.deployment.id': 'deployment-1',
                'wiolett.gateway.deployment.role': 'router',
              },
            },
            {
              name: 'gwav-deployment-policy-1-placemen-blue',
              state: 'running',
              image: `registry/app@sha256:${'a'.repeat(64)}`,
              imageId: `sha256:${'a'.repeat(64)}`,
              labels: {
                'wiolett.gateway.deployment.id': 'deployment-1',
                'wiolett.gateway.deployment.role': 'app',
                'wiolett.gateway.deployment.slot': 'blue',
                'wiolett.gateway.availability.policy': 'policy-1',
                'wiolett.gateway.availability.placement': 'placement-1',
                'wiolett.gateway.availability.generation': '3',
                'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
              },
            },
          ];
        }
        return { success: true };
      }),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
      } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({ generation: 3, state: 'prepared' });
    adapter.claimGeneration = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 3 });

    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 3,
      idempotencyKey: 'retry-key',
      resource: {
        kind: 'deployment',
        currentNodeId: 'origin-node',
        resourceId: 'deployment-1',
        displayName: 'app',
        specFingerprint: 'fingerprint',
        portableSpec: {
          desiredConfig: { image: `registry/app@sha256:${'a'.repeat(64)}` },
          routerImage: 'nginx:alpine',
          activeSlot: 'blue',
          routes: [{ hostPort: 8080, containerPort: 80 }],
          health: { path: '/' },
          slots: { blue: 'origin-blue', green: 'origin-green' },
        },
        imageReference: `registry/app@sha256:${'a'.repeat(64)}`,
      },
    };

    await expect(adapter.verifyRuntimeOwnership(context, adapter.runtime(context), 'blue')).rejects.toMatchObject({
      code: 'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
    });

    await expect(adapter.ensurePlacement(context)).resolves.toMatchObject({ serving: true });
    expect(actions.indexOf('remove')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('remove')).toBeLessThan(actions.indexOf('create'));

    actions.length = 0;
    inspectRows = [
      {
        name: 'gwav-deployment-policy-1-placemen-router',
        state: 'created',
        imageId: `sha256:${'b'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.role': 'router',
        },
      },
      {
        name: 'gwav-deployment-policy-1-placemen-blue',
        state: 'running',
        image: `registry/app@sha256:${'a'.repeat(64)}`,
        imageId: `sha256:${'a'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.role': 'app',
          'wiolett.gateway.deployment.slot': 'blue',
          'wiolett.gateway.availability.policy': 'policy-1',
          'wiolett.gateway.availability.placement': 'placement-1',
          'wiolett.gateway.availability.generation': '2',
          'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
        },
      },
    ];
    adapter.inspectOptional.mockResolvedValue({
      generation: 2,
      state: 'active',
      runtimeIdentity: { activeSlot: 'blue' },
    });

    await expect(adapter.ensurePlacement(context)).resolves.toMatchObject({ serving: true });
    expect(actions.indexOf('remove')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('remove')).toBeLessThan(actions.indexOf('create'));
    expect(actions).not.toContain('deploy_slot');
  });
});

describe('Docker deployment Availability adoption', () => {
  it('persists the switched active slot and stopped inactive slot when disabling Availability', async () => {
    const persisted: Array<Record<string, any>> = [];
    const update = vi.fn(() => ({
      set: vi.fn((values: Record<string, any>) => {
        persisted.push(values);
        return { where: vi.fn().mockResolvedValue([]) };
      }),
    }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ desiredConfig: { image: 'nginx:alpine' } }]),
          })),
        })),
      })),
      transaction: vi.fn(async (callback: (tx: any) => Promise<void>) => callback({ update })),
    };
    const dispatch = {
      sendDockerImageCommand: vi.fn(),
      sendDockerDeploymentCommand: vi.fn(async (_nodeId: string, action: string) => {
        if (action === 'deploy_slot') {
          return { success: true, detail: JSON.stringify({ containerId: 'new-green', greenContainerId: 'new-green' }) };
        }
        if (action === 'switch') {
          return { success: true, detail: JSON.stringify({ containerId: 'new-green', activeSlot: 'green' }) };
        }
        return { success: true };
      }),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      db as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
        adopt: vi.fn(),
      } as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 7,
      state: 'active',
      runtimeIdentity: {
        activeSlot: 'blue',
        blueContainerId: 'old-blue',
        greenContainerId: 'old-green',
      },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.verifyRuntimeOwnership = vi.fn().mockResolvedValue('blue');
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 8, state: 'single' });

    await adapter.adoptPlacementAsSingle({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'origin-node',
      generation: 8,
      idempotencyKey: 'disable-8',
      resource: {
        kind: 'deployment',
        resourceId: 'deployment-1',
        displayName: 'app',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        running: true,
        imageReference: 'nginx:alpine',
        sourceImageReference: 'nginx:alpine',
        portableSpec: {
          activeSlot: 'blue',
          desiredConfig: { image: 'nginx:alpine', labels: {} },
          routerName: 'router',
          networkName: 'network',
          slots: { blue: 'app-blue', green: 'app-green' },
        },
      },
    } as never);

    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activeSlot: 'green', status: 'ready' }),
        expect.objectContaining({
          containerName: 'app-green',
          containerId: 'new-green',
          status: 'running',
          health: 'healthy',
        }),
        expect.objectContaining({
          containerName: 'app-blue',
          containerId: 'old-blue',
          status: 'stopped',
          health: 'unknown',
        }),
      ])
    );
  });
});

describe('deployment desired revision acknowledgement', () => {
  function fixture(nodeId = 'origin', priorGeneration = 2, actualImage = 'old', actualFingerprint = 'old') {
    const image = `registry/api@sha256:${'a'.repeat(64)}`;
    const oldImage = `registry/api@sha256:${'b'.repeat(64)}`;
    const context = {
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-3',
      nodeId,
      generation: 3,
      idempotencyKey: 'rollout-3',
      targetActiveSlot: 'green',
      resource: {
        kind: 'deployment',
        resourceId: 'deployment-1',
        currentNodeId: 'origin',
        displayName: 'api',
        specFingerprint: 'desired-spec',
        imageReference: image,
        portableSpec: {
          activeSlot: 'blue',
          routerName: 'router',
          networkName: 'network',
          slots: { blue: 'api-blue', green: 'api-green' },
          desiredConfig: { image, env: { VERSION: 'v3' }, runtimeProfile: 'secure' },
        },
      },
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      {
        prepare: vi.fn().mockResolvedValue({ environment: {}, networkNames: [], extraHosts: {} }),
        activate: vi.fn(),
      } as never
    ) as any;
    const runtime = adapter.runtime(context);
    const app = (slot: string, appImage: string, fingerprint: string) => ({
      id: `${slot}-id`,
      name: runtime.slots[slot],
      state: 'running',
      image: appImage,
      imageId: `sha256:${'c'.repeat(64)}`,
      labels: {
        'wiolett.gateway.deployment.id': 'deployment-1',
        'wiolett.gateway.deployment.managed': 'true',
        'wiolett.gateway.deployment.role': 'app',
        'wiolett.gateway.deployment.slot': slot,
        'wiolett.gateway.availability.policy': 'policy-1',
        'wiolett.gateway.availability.placement': 'placement-1',
        'wiolett.gateway.availability.generation': '3',
        'wiolett.gateway.availability.spec-fingerprint': fingerprint,
      },
    });
    const rows: Array<Record<string, any>> = [
      {
        name: runtime.routerName,
        state: 'running',
        imageId: `sha256:${'d'.repeat(64)}`,
        labels: {
          'wiolett.gateway.deployment.id': 'deployment-1',
          'wiolett.gateway.deployment.managed': 'true',
          'wiolett.gateway.deployment.role': 'router',
        },
      },
      app(
        'green',
        actualImage === 'desired' ? image : oldImage,
        actualFingerprint === 'desired' ? 'desired-spec' : 'old-spec'
      ),
    ];
    let activeSlot = 'green';
    let persisted: Record<string, any> = {
      generation: priorGeneration,
      state: 'active',
      runtimeIdentity: { activeSlot: 'green' },
    };
    const failure = { deploy: false, stop: false };
    const commands: Array<{ action: string; slot?: string; config: any }> = [];
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_node: string, action: string, payload: any) => {
        const config = JSON.parse(payload.configJson);
        commands.push({ action, slot: payload.slot, config });
        if (action === 'inspect') return { success: true, detail: JSON.stringify({ containers: rows }) };
        if (action === 'deploy_slot') {
          expect(payload.slot).not.toBe(activeSlot);
          if (failure.deploy) return { success: false, error: 'candidate unhealthy' };
          const index = rows.findIndex((row) => row.name === runtime.slots[payload.slot]);
          const replacement = app(
            payload.slot,
            config.desiredConfig.image,
            config.desiredConfig.labels['wiolett.gateway.availability.spec-fingerprint']
          );
          if (index < 0) rows.push(replacement);
          else rows[index] = replacement;
          return { success: true, detail: JSON.stringify({ containerId: `${payload.slot}-new-id` }) };
        }
        if (action === 'switch') activeSlot = payload.slot;
        if (action === 'stop_slot') {
          expect(payload.slot).not.toBe(activeSlot);
          if (failure.stop) {
            failure.stop = false;
            return { success: false, error: 'stop failed' };
          }
          rows.find((row) => row.name === runtime.slots[payload.slot])!.state = 'exited';
        }
        return { success: true };
      }),
    };
    adapter.dispatch = dispatch;
    adapter.inspectOptional = vi.fn(async () => persisted);
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.daemon = vi.fn(async (_ctx: unknown, _action: string, config: any) => {
      persisted = { generation: 3, state: 'active', runtimeIdentity: config.runtimeIdentity };
      return persisted;
    });
    return { adapter, context, commands, rows, failure, image };
  }

  it.each([
    ['origin', 2, 'old', 'desired'],
    ['origin', 3, 'old', 'desired'],
    ['origin', 2, 'desired', 'old'],
    ['origin', 3, 'desired', 'old'],
    ['remote', 2, 'old', 'desired'],
    ['remote', 3, 'desired', 'old'],
  ] as const)('updates stale active target on %s at prior generation %s (%s image/%s spec)', async (node, generation, image, spec) => {
    const h = fixture(node, generation, image, spec);
    await expect(h.adapter.ensurePlacement(h.context)).resolves.toMatchObject({
      serving: true,
      runtimeIdentity: { activeSlot: 'green', containerId: 'green-new-id' },
    });
    expect(h.commands.filter(({ action }) => action !== 'inspect').map(({ action, slot }) => [action, slot])).toEqual([
      ['deploy_slot', 'blue'],
      ['switch', 'blue'],
      ['stop_slot', 'green'],
      ['deploy_slot', 'green'],
      ['switch', 'green'],
      ['stop_slot', 'blue'],
    ]);
    expect(
      h.commands
        .filter(({ action }) => action === 'deploy_slot')
        .every(
          ({ config }) =>
            config.desiredConfig.image === h.image &&
            config.desiredConfig.env.VERSION === 'v3' &&
            config.desiredConfig.runtimeProfile === 'secure'
        )
    ).toBe(true);
  });

  it.each([
    'origin',
    'remote',
  ])('reuses a matching active target on %s without deleting the inactive old revision', async (node) => {
    const h = fixture(node, 3, 'desired', 'desired');
    const green = h.rows[1]!;
    h.rows.push({
      ...green,
      name: h.adapter.runtime(h.context).slots.blue,
      state: 'exited',
      image: `registry/api@sha256:${'b'.repeat(64)}`,
      labels: {
        ...green.labels,
        'wiolett.gateway.deployment.slot': 'blue',
        'wiolett.gateway.availability.spec-fingerprint': 'old-spec',
      },
    });
    await expect(h.adapter.ensurePlacement(h.context)).resolves.toMatchObject({ serving: true });
    expect(h.commands.map(({ action }) => action)).toEqual(['inspect']);
  });

  it('does not acknowledge a failed candidate or switch traffic away from the old active slot', async () => {
    const h = fixture();
    h.failure.deploy = true;
    await expect(h.adapter.ensurePlacement(h.context)).rejects.toMatchObject({
      code: 'AVAILABILITY_DEPLOYMENT_ROLLOUT_FAILED',
    });
    expect(h.commands.map(({ action }) => action)).toEqual(['inspect', 'deploy_slot']);
    expect(h.adapter.daemon).not.toHaveBeenCalled();
  });

  it('retries a failed old-slot stop from the persisted switched target, preserving live traffic', async () => {
    const h = fixture();
    h.failure.stop = true;
    await expect(h.adapter.ensurePlacement(h.context)).rejects.toMatchObject({
      code: 'AVAILABILITY_DEPLOYMENT_STOP_FAILED',
    });
    expect(h.adapter.daemon).toHaveBeenLastCalledWith(
      expect.anything(),
      'activate',
      expect.objectContaining({ runtimeIdentity: expect.objectContaining({ activeSlot: 'blue' }) })
    );
    h.commands.length = 0;
    await expect(h.adapter.ensurePlacement(h.context)).resolves.toMatchObject({
      serving: true,
      runtimeIdentity: { activeSlot: 'green' },
    });
    expect(h.commands.filter(({ action }) => action !== 'inspect').map(({ action, slot }) => [action, slot])).toEqual([
      ['deploy_slot', 'green'],
      ['switch', 'green'],
      ['stop_slot', 'blue'],
    ]);
  });

  it.each(['origin', 'remote'])('never removes a foreign deployment occupying %s runtime names', async (node) => {
    const h = fixture(node);
    h.rows[1]!.labels['wiolett.gateway.deployment.id'] = 'foreign-deployment';
    await expect(h.adapter.ensurePlacement(h.context)).rejects.toMatchObject({
      code: 'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
    });
    expect(h.commands.every(({ action }) => action === 'inspect')).toBe(true);
    expect(h.adapter.daemon).not.toHaveBeenCalled();
  });
});

describe('Docker Availability same-generation reconnect recovery', () => {
  it('reactivates an existing container placement without recreating it', async () => {
    const image = `registry/api@sha256:${'a'.repeat(64)}`;
    const actions: string[] = [];
    const dispatch = {
      sendDockerContainerCommand: vi.fn(async (_nodeId: string, action: string) => {
        actions.push(action);
        if (action === 'inspect') {
          return {
            success: true,
            detail: JSON.stringify({
              Id: 'container-existing',
              Config: {
                Image: image,
                Labels: {
                  'wiolett.gateway.availability.policy': 'policy-1',
                  'wiolett.gateway.availability.placement': 'placement-1',
                  'wiolett.gateway.availability.generation': '5',
                  'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
                },
              },
              HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
              Image: `sha256:${'b'.repeat(64)}`,
              State: { Running: true, Status: 'running' },
            }),
          };
        }
        return { success: true };
      }),
      sendDockerNetworkCommand: vi.fn().mockResolvedValue({ success: true }),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({
        environment: { DATABASE_URL: 'postgres://placement' },
        networkNames: ['gateway-db-placement'],
        extraHosts: { database: '172.30.0.1' },
      }),
      activate: vi.fn(),
    };
    const adapter = new DockerContainerAvailabilityAdapter(
      {} as never,
      dispatch as never,
      {} as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 5,
      state: 'active',
      runtimeIdentity: { containerId: 'container-existing' },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.waitUntilReady = vi.fn();
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 5, state: 'active' });

    await adapter.ensurePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 5,
      idempotencyKey: 'heal-5',
      recovering: true,
      resource: {
        kind: 'container',
        resourceId: 'api',
        displayName: 'api',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        imageReference: image,
        portableSpec: { image, restartPolicy: 'unless-stopped' },
      },
    });

    expect(actions).toContain('start');
    expect(actions).not.toContain('remove');
    expect(actions).not.toContain('create');
  });

  it('reactivates an existing deployment placement without recreating its slots', async () => {
    const actions: string[] = [];
    const dispatch = {
      sendDockerDeploymentCommand: vi.fn(async (_nodeId: string, action: string) => {
        actions.push(action);
        if (action === 'inspect') {
          return {
            success: true,
            detail: JSON.stringify({
              containers: [
                {
                  id: 'existing-slot',
                  name: 'gwav-deployment-policy-1-placemen-blue',
                  image: `registry/api@sha256:${'a'.repeat(64)}`,
                  imageId: `sha256:${'a'.repeat(64)}`,
                  labels: {
                    'wiolett.gateway.deployment.id': 'deployment-1',
                    'wiolett.gateway.deployment.role': 'app',
                    'wiolett.gateway.availability.policy': 'policy-1',
                    'wiolett.gateway.availability.placement': 'placement-1',
                    'wiolett.gateway.availability.generation': '5',
                    'wiolett.gateway.availability.spec-fingerprint': 'fingerprint',
                  },
                },
              ],
            }),
          };
        }
        return { success: true };
      }),
    };
    const projector = {
      prepare: vi.fn().mockResolvedValue({
        environment: { DATABASE_URL: 'postgres://placement' },
        networkNames: ['gateway-db-placement'],
        extraHosts: { database: '172.30.0.1' },
      }),
      activate: vi.fn(),
    };
    const adapter = new DockerDeploymentAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.inspectOptional = vi.fn().mockResolvedValue({
      generation: 5,
      state: 'active',
      runtimeIdentity: { activeSlot: 'blue', blueContainerId: 'existing-slot' },
    });
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.runtimeOwnershipIsValid = vi.fn().mockReturnValue(true);
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 5, state: 'active' });

    await adapter.ensurePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 5,
      idempotencyKey: 'heal-5',
      recovering: true,
      resource: {
        kind: 'deployment',
        resourceId: 'deployment-1',
        displayName: 'api',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        imageReference: `registry/api@sha256:${'a'.repeat(64)}`,
        portableSpec: {
          activeSlot: 'blue',
          desiredConfig: { image: `registry/api@sha256:${'a'.repeat(64)}`, labels: {} },
        },
      },
    });

    expect(actions).toEqual(['inspect']);
    expect(adapter.daemon).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'remote-node', generation: 5 }),
      'activate',
      expect.objectContaining({ runtimeIdentity: expect.objectContaining({ activeSlot: 'blue' }) })
    );
  });

  it('reactivates an existing Compose placement without pull/apply', async () => {
    const dispatch = { sendDockerComposeCommand: vi.fn() };
    const projector = {
      prepare: vi.fn().mockResolvedValue({
        environment: {},
        networkNames: ['gateway-db-placement'],
        extraHosts: {},
        composeYaml: 'services: {}',
        composeSecrets: {},
      }),
      activate: vi.fn(),
    };
    const adapter = new DockerComposeAvailabilityAdapter(
      {} as never,
      dispatch as never,
      { getDecryptedMap: vi.fn().mockResolvedValue({}) } as never,
      projector as never
    ) as any;
    adapter.claimAndFence = vi.fn();
    adapter.fence = vi.fn();
    adapter.listRuntimeContainers = vi.fn().mockResolvedValue([{ id: 'existing-compose-container' }]);
    adapter.composeRuntimeHasForeignCollision = vi.fn().mockReturnValue(false);
    adapter.composeRuntimeOwnershipIsValid = vi.fn().mockReturnValue(true);
    adapter.waitUntilReady = vi.fn();
    adapter.runtimeIdentity = vi.fn().mockResolvedValue({
      projectId: 'project-1',
      projectName: 'gwav-compose-policy-1-placement',
      containers: [{ containerId: 'existing-compose-container', serviceName: 'web' }],
    });
    adapter.daemon = vi.fn().mockResolvedValue({ generation: 5, state: 'active' });

    await adapter.ensurePlacement({
      policyId: 'policy-1',
      placementId: 'placement-1',
      operationId: 'operation-1',
      nodeId: 'remote-node',
      generation: 5,
      idempotencyKey: 'heal-5',
      recovering: true,
      resource: {
        kind: 'compose',
        resourceId: 'project-1',
        displayName: 'stack',
        currentNodeId: 'origin-node',
        specFingerprint: 'fingerprint',
        composeRevisionId: 'revision-1',
        portableSpec: {
          configDigest: 'a'.repeat(64),
          normalizedModel: { services: { web: { image: 'nginx:alpine' } } },
        },
      },
    });

    expect(dispatch.sendDockerComposeCommand).not.toHaveBeenCalled();
    expect(adapter.waitUntilReady).toHaveBeenCalledOnce();
  });
});

describe('Managed database Availability projector', () => {
  it('replaces the logical Compose binding with a placement-local binding', async () => {
    const original = addManagedDatabaseBindingToYaml('services:\n  web:\n    image: nginx:alpine\n', 'web', {
      bindingId: 'binding-1',
      networkName: 'gateway-db-original',
      hostAlias: 'db-original',
      hostAddress: '172.18.0.1',
      environment: { DATABASE_URL: '' },
    });
    const projector = new ManagedDatabaseAvailabilityProjector(
      {
        prepareAvailabilityPlacement: vi.fn().mockResolvedValue([
          {
            bindingId: 'binding-1',
            projectionId: 'projection-1',
            networkName: 'gateway-db-placement',
            connectorAlias: 'db-original',
            connectorAddress: '172.19.0.1',
            logicalNetworkName: 'gateway-db-original',
            logicalConnectorAddress: '172.18.0.1',
            environment: { DATABASE_URL: 'postgres://placement' },
            composeServiceName: 'web',
          },
        ]),
      } as never,
      {} as never
    );

    const prepared = await projector.prepare({
      placementId: 'placement-1',
      resource: { kind: 'compose', portableSpec: { yaml: original.yaml } },
    } as never);

    expect(prepared.composeYaml).toContain(`\${${composeBindingSecretKey('projection-1', 'DATABASE_URL')}}`);
    expect(prepared.composeYaml).not.toContain(`\${${composeBindingSecretKey('binding-1', 'DATABASE_URL')}}`);
    expect(prepared.composeYaml).toContain('gateway-db-placement');
    expect(prepared.composeYaml).not.toContain('gateway-db-original');
  });

  it('requires the placement-local Secure Link listener capability on every candidate', async () => {
    const bindings = { availabilityPreflight: vi.fn().mockResolvedValue([]) };
    const registry = { hasCapability: vi.fn().mockReturnValue(false) };
    const projector = new ManagedDatabaseAvailabilityProjector(bindings as never, registry as never);
    const result = await projector.preflight(
      {
        kind: 'deployment',
        reference: { type: 'deployment', deploymentId: '22222222-2222-4222-8222-222222222222' },
        resourceId: '22222222-2222-4222-8222-222222222222',
        displayName: 'api',
        currentNodeId: candidate.id,
        viewScope: 'docker:containers:view',
        manageScope: 'docker:containers:manage',
        specFingerprint: 'fingerprint',
        portableSpec: {},
        running: true,
      },
      [candidate],
      ['databases:edit:database-1']
    );
    expect(bindings.availabilityPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: '22222222-2222-4222-8222-222222222222' }),
      ['databases:edit:database-1']
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'AVAILABILITY_DATABASE_LINK_CAPABILITY_UNAVAILABLE',
        nodeId: candidate.id,
      })
    );
  });
});
