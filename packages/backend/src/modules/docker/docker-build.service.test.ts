import { describe, expect, it, vi } from 'vitest';
import type { DockerBuildStatus } from '@/db/schema/index.js';
import {
  assertSupportedDockerBuildResourcePolicy,
  canTransitionDockerBuild,
  DockerBuildService,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  expiredDockerBuildDisposition,
  redactDockerBuildLog,
} from './docker-build.service.js';

function queuedBuild(id: string) {
  const now = new Date('2026-08-23T00:00:00.000Z');
  return {
    id,
    sourceBindingId: '11111111-1111-4111-8111-111111111111',
    batchId: null,
    dedupeKey: `source:${id}`,
    trigger: 'manual' as const,
    triggerDeliveryId: null,
    repositoryRemoteId: '99',
    repositoryFullPath: 'acme/api',
    ref: 'refs/heads/main',
    commitSha: id.padEnd(40, 'a').slice(0, 40),
    serviceName: null,
    dockerfilePath: 'Dockerfile',
    contextPath: '.',
    buildArgs: {},
    applicationRoot: '.',
    packageManager: null,
    packageManagerVersion: null,
    nodeVersion: null,
    buildScript: null,
    artifactDirectory: null,
    publishTag: null,
    sourceConfigGeneration: 1,
    status: 'queued' as DockerBuildStatus,
    builderNodeId: null,
    platform: null,
    attempt: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseHeartbeatAt: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    cancellationRequestedById: null,
    supersededByBuildId: null,
    errorCode: null,
    errorMessage: null,
    progress: {},
    createdById: null,
    createdAt: now,
    queuedAt: now,
    startedAt: null,
    updatedAt: now,
    completedAt: null,
  };
}

function claimDatabase(rows: ReturnType<typeof queuedBuild>[]) {
  let chain = Promise.resolve();
  let candidateId: string | null = null;
  const tx = {
    execute: vi.fn(async () => undefined),
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if (!selection) return Promise.resolve([]);
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(async () => {
                const candidate = rows.find((row) => row.status === 'queued');
                candidateId = candidate?.id ?? null;
                return candidate ? [{ id: candidate.id }] : [];
              }),
            })),
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            const row = rows.find((candidate) => candidate.id === candidateId && candidate.status === 'queued');
            if (!row) return [];
            Object.assign(row, values, { attempt: row.attempt + 1 });
            return [row];
          }),
        })),
      })),
    })),
  };
  return {
    transaction: vi.fn(<T>(callback: (database: typeof tx) => Promise<T>) => {
      const current = chain.then(() => callback(tx));
      chain = current.then(
        () => undefined,
        () => undefined
      );
      return current;
    }),
  };
}

describe('DockerBuildService', () => {
  it('enforces the forward-only build state machine', () => {
    expect(canTransitionDockerBuild('queued', 'claimed')).toBe(true);
    expect(canTransitionDockerBuild('claimed', 'checking_out')).toBe(true);
    expect(canTransitionDockerBuild('checking_out', 'building')).toBe(true);
    expect(canTransitionDockerBuild('building', 'scanning')).toBe(true);
    expect(canTransitionDockerBuild('scanning', 'pushing')).toBe(true);
    expect(canTransitionDockerBuild('pushing', 'deploying')).toBe(true);
    expect(canTransitionDockerBuild('deploying', 'succeeded')).toBe(true);
    expect(canTransitionDockerBuild('building', 'succeeded')).toBe(false);
    expect(canTransitionDockerBuild('succeeded', 'queued')).toBe(false);
  });

  it('serializes concurrent claims so one queued build is owned by only one builder', async () => {
    const rows = [queuedBuild('build-1'), queuedBuild('build-2')];
    const service = new DockerBuildService(claimDatabase(rows) as never);
    const [first, second] = await Promise.all([
      service.claimNext({
        builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leaseOwner: 'worker-a',
        platform: 'linux/amd64',
      }),
      service.claimNext({
        builderNodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        leaseOwner: 'worker-b',
        platform: 'linux/amd64',
      }),
    ]);

    expect(first?.id).toBe('build-1');
    expect(second?.id).toBe('build-2');
    expect(new Set(rows.map((row) => row.leaseOwner))).toEqual(new Set(['worker-a', 'worker-b']));
    expect(rows.every((row) => row.attempt === 1 && row.status === 'claimed')).toBe(true);
  });

  it('checks internal registry admission before creating queue state', async () => {
    const service = new DockerBuildService({ transaction: vi.fn() } as never);
    const guard = vi.fn().mockRejectedValue(new Error('registry is read-only'));
    service.setAdmissionGuard(guard);

    await expect(
      service.enqueue({
        sourceBindingId: '11111111-1111-4111-8111-111111111111',
        commitSha: 'a'.repeat(40),
        trigger: 'manual',
      })
    ).rejects.toThrow('registry is read-only');
    expect(guard).toHaveBeenCalledOnce();
  });

  it('checks the build license before infrastructure admission', async () => {
    const service = new DockerBuildService({ transaction: vi.fn() } as never);
    const licenseGuard = vi.fn().mockRejectedValue(new Error('business required'));
    const admissionGuard = vi.fn();
    service.setLicenseGuard(licenseGuard);
    service.setAdmissionGuard(admissionGuard);

    await expect(
      service.enqueue({
        sourceBindingId: '11111111-1111-4111-8111-111111111111',
        commitSha: 'a'.repeat(40),
        trigger: 'manual',
      })
    ).rejects.toThrow('business required');
    expect(licenseGuard).toHaveBeenCalledOnce();
    expect(admissionGuard).not.toHaveBeenCalled();
  });

  it('rejects custom resource values that the isolated Build Worker cannot enforce per job', () => {
    expect(() => assertSupportedDockerBuildResourcePolicy({})).not.toThrow();
    expect(() =>
      assertSupportedDockerBuildResourcePolicy({
        cpuLimitMillis: dockerBuildLimits.enforcedCpuLimitMillis,
        memoryLimitBytes: dockerBuildLimits.enforcedMemoryLimitBytes,
        diskLimitBytes: dockerBuildLimits.enforcedDiskLimitBytes,
      })
    ).not.toThrow();
    expect(() => assertSupportedDockerBuildResourcePolicy({ memoryLimitBytes: 1024 ** 3 })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_BUILD_RESOURCE_PROFILE' })
    );
  });

  it('retries expired leases only while attempts remain and cancellation is absent', () => {
    expect(expiredDockerBuildDisposition({ attempt: 1, maxAttempts: 3, cancellationRequestedAt: null })).toBe('retry');
    expect(expiredDockerBuildDisposition({ attempt: 3, maxAttempts: 3, cancellationRequestedAt: null })).toBe('failed');
    expect(expiredDockerBuildDisposition({ attempt: 1, maxAttempts: 3, cancellationRequestedAt: new Date() })).toBe(
      'cancelled'
    );
  });

  it('cancels a queued build without assigning it to a worker', async () => {
    const current = queuedBuild('build-cancel');
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [current]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...current, ...values }]) })),
        })),
      })),
    };
    const service = new DockerBuildService(db as never);
    await expect(service.requestCancellation(current.id, 'user-1')).resolves.toMatchObject({
      status: 'cancelled',
      builderNodeId: null,
      errorCode: 'CANCELLED_BY_USER',
    });
  });

  it('retries a terminal build as a new forced queue entry', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({ ...queuedBuild('build-retry'), status: 'failed' } as never);
    const next = queuedBuild('build-new');
    const enqueue = vi
      .spyOn(service, 'enqueue')
      .mockResolvedValue({ build: next, builds: [next], batch: null, created: true });
    await service.retry('build-retry', 'user-1');
    expect(enqueue).toHaveBeenCalledWith({
      sourceBindingId: '11111111-1111-4111-8111-111111111111',
      commitSha: queuedBuild('build-retry').commitSha,
      trigger: 'retry',
      createdById: 'user-1',
      force: true,
    });
  });

  it('enforces vulnerability thresholds without requiring published SBOM or provenance', () => {
    expect(
      evaluateDockerArtifactPolicy(
        { vulnerabilityThreshold: 'high' },
        { scanSummary: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } }
      )
    ).toEqual({ decision: 'approved', reason: null });

    expect(
      evaluateDockerArtifactPolicy(
        { vulnerabilityThreshold: 'high' },
        {
          sbomDigest: 'sha256:sbom',
          provenanceDigest: 'sha256:provenance',
          scanSummary: { critical: 0, high: 1, medium: 4, low: 8, unknown: 0 },
        }
      )
    ).toMatchObject({ decision: 'rejected', reason: expect.stringContaining('high') });

    expect(
      evaluateDockerArtifactPolicy(
        { vulnerabilityThreshold: 'high' },
        {
          sbomDigest: 'sha256:sbom',
          provenanceDigest: 'sha256:provenance',
          scanSummary: { critical: 0, high: 0, medium: 4, low: 8, unknown: 0 },
        }
      )
    ).toEqual({ decision: 'approved', reason: null });
  });

  it('redacts explicit values, credential URLs, and named build secrets', () => {
    const output = redactDockerBuildLog(
      'TOKEN=super-secret\nhttps://ci-user:password@example.test/repo.git\nraw super-secret',
      { secretValues: ['super-secret', 'x'], secretNames: ['TOKEN'] }
    );
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain(':password@');
    expect(output).toContain('TOKEN=[REDACTED]');
    expect(redactDockerBuildLog('short=x', { secretValues: ['x'] })).toBe('short=[REDACTED]');
  });

  it('rejects a persisted log chunk larger than 256 KiB before touching storage', async () => {
    const service = new DockerBuildService({} as never);
    await expect(
      service.appendLog('build-1', 0, 'x'.repeat(dockerBuildLimits.logChunkMaxBytes + 1))
    ).rejects.toMatchObject({ code: 'BUILD_LOG_CHUNK_TOO_LARGE' });
  });

  it('rejects writes beyond the 10 MiB build log cap', async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ bytes: dockerBuildLimits.logTotalMaxBytes }]),
        })),
      })),
    };
    const service = new DockerBuildService(db as never);
    await expect(service.appendLog('build-1', 0, 'x')).rejects.toMatchObject({ code: 'BUILD_LOG_LIMIT_EXCEEDED' });
  });

  it('records an immutable successful builder artifact before completing the lease', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-success'),
      status: 'scanning',
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-a',
      artifact: null,
      sourceAutoDeploy: true,
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);
    const transition = vi.spyOn(service, 'transition').mockImplementation(
      async (_id, _lease, status) =>
        ({
          ...queuedBuild('build-success'),
          status,
        }) as never
    );
    const recordArtifact = vi.spyOn(service, 'recordArtifact').mockResolvedValue({
      artifact: { policyDecision: 'approved' },
      created: true,
    } as never);
    service.setArtifactRollout(async () => 'deployed');

    await service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      buildId: 'build-success',
      status: 'succeeded',
      sequence: '0',
      logChunk: Buffer.alloc(0),
      progressJson: '',
      artifactRepository: 'gateway/builds/source',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      artifactSizeBytes: '1234',
      platform: 'linux/amd64',
      sbomDigest: '',
      provenanceDigest: '',
      scanSummaryJson:
        '{"scanner":"grype","critical":0,"high":0,"medium":0,"low":1,"unknown":0,"vulnerabilities":[{"id":"CVE-2026-1001","severity":"low","packageName":"busybox","installedVersion":"1.36.1","packageType":"apk","fixedVersions":["1.36.2"],"fixState":"fixed","namespace":"alpine","dataSource":"https://example.com"}],"vulnerabilitiesTruncated":0}',
      policyDecision: 'pending',
      errorCode: '',
      errorMessage: '',
      occurredAtUnixMs: '0',
    });

    expect(transition).toHaveBeenNthCalledWith(1, 'build-success', 'worker-a', 'pushing');
    expect(transition).toHaveBeenNthCalledWith(2, 'build-success', 'worker-a', 'deploying');
    expect(transition).toHaveBeenNthCalledWith(3, 'build-success', 'worker-a', 'succeeded');
    expect(recordArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scanSummary: expect.objectContaining({
          vulnerabilities: [
            expect.objectContaining({
              id: 'CVE-2026-1001',
              packageName: 'busybox',
              fixedVersions: ['1.36.2'],
            }),
          ],
        }),
      })
    );
  });

  it('prepares a Compose revision even when automatic deployment is disabled', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('compose-build'),
      status: 'scanning',
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-a',
      sourceAutoDeploy: false,
      target: {
        kind: 'compose_project',
        nodeId: 'node-1',
        composeProjectId: 'project-1',
        name: 'demo',
        serviceName: 'api',
      },
    } as never);
    const transition = vi
      .spyOn(service, 'transition')
      .mockImplementation(async (_id, _lease, status) => ({ ...queuedBuild('compose-build'), status }) as never);
    vi.spyOn(service, 'recordArtifact').mockResolvedValue({
      artifact: { policyDecision: 'approved' },
      created: true,
    } as never);
    const rollout = vi.fn().mockResolvedValue('pending' as const);
    service.setArtifactRollout(rollout);

    await service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      buildId: 'compose-build',
      status: 'succeeded',
      sequence: '0',
      logChunk: Buffer.alloc(0),
      progressJson: '',
      artifactRepository: 'gateway/builds/source/api',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      artifactSizeBytes: '1234',
      platform: 'linux/amd64',
      sbomDigest: '',
      provenanceDigest: '',
      scanSummaryJson: '{"critical":0,"high":0,"medium":0,"low":0,"unknown":0}',
      policyDecision: 'pending',
      errorCode: '',
      errorMessage: '',
      occurredAtUnixMs: '0',
    });

    expect(rollout).toHaveBeenCalledWith('compose-build');
    expect(transition).toHaveBeenLastCalledWith('compose-build', 'worker-a', 'succeeded');
  });

  it('rejects builder events from a node that does not own the lease', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-owner'),
      status: 'building',
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-a',
      artifact: null,
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);
    await expect(
      service.handleDaemonEvent('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
        buildId: 'build-owner',
        status: 'heartbeat',
        sequence: '0',
        logChunk: Buffer.alloc(0),
        progressJson: '',
        artifactRepository: '',
        artifactDigest: '',
        artifactSizeBytes: '0',
        platform: '',
        sbomDigest: '',
        provenanceDigest: '',
        scanSummaryJson: '',
        policyDecision: '',
        errorCode: '',
        errorMessage: '',
        occurredAtUnixMs: '0',
      })
    ).rejects.toMatchObject({ code: 'BUILD_EVENT_OWNER_MISMATCH' });
  });
});
