import { describe, expect, it, vi } from 'vitest';
import type { DockerBuildStatus } from '@/db/schema/index.js';
import {
  assertSupportedDockerBuildResourcePolicy,
  canAcceptDockerBuildLogEvent,
  canTransitionDockerBuild,
  DockerBuildService,
  dockerBuildLimits,
  evaluateDockerArtifactPolicy,
  expiredDockerBuildDisposition,
  redactDockerBuildLog,
} from './docker-build.service.js';
import { ACTIVE_BUILD_STATUSES, WORKER_ACTIVE_BUILD_STATUSES } from './docker-build-policy.js';

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

function rolloutProgress(buildId: string, attempt = 1, phase: 'accepted' | 'executing' = 'accepted') {
  return {
    rollout: {
      operationId: `docker-build:${buildId}:attempt:${attempt}`,
      attempt,
      phase,
    },
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
  it('keeps the default build lease at one minute', () => {
    expect(dockerBuildLimits.defaultLeaseMs).toBe(60_000);
  });

  it('keeps deploying in lease accounting but releases Build Worker capacity', () => {
    expect(ACTIVE_BUILD_STATUSES).toContain('deploying');
    expect(WORKER_ACTIVE_BUILD_STATUSES).not.toContain('deploying');
  });

  it('persists an accepted rollout operation while atomically transferring the worker lease', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    let values: Record<string, unknown> = {};
    const db = {
      update: vi.fn(() => ({
        set: vi.fn((next: Record<string, unknown>) => {
          values = next;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [
                {
                  ...queuedBuild('build-transfer'),
                  ...next,
                  attempt: 2,
                },
              ]),
            })),
          };
        }),
      })),
    };
    const service = new DockerBuildService(db as never);

    const row = await service.beginArtifactRollout('build-transfer', 'worker-a', 2, { stage: 'pushed' }, now);

    expect(row).toMatchObject({ status: 'deploying', attempt: 2 });
    expect(values.leaseOwner).toMatch(/^gateway-rollout:/);
    expect(values.progress).toEqual({
      stage: 'pushed',
      rollout: {
        operationId: 'docker-build:build-transfer:attempt:2',
        attempt: 2,
        phase: 'accepted',
      },
    });
    expect(values.leaseExpiresAt).toEqual(new Date(now.getTime() + 60_000));
  });

  it('persists the executing phase before invoking an external rollout', async () => {
    const current = {
      ...queuedBuild('build-executing'),
      status: 'deploying' as const,
      attempt: 2,
      leaseOwner: 'rollout-a',
      progress: rolloutProgress('build-executing', 2, 'accepted'),
    };
    let values: Record<string, unknown> = {};
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [current]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((next: Record<string, unknown>) => {
          values = next;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...current, ...next }]),
            })),
          };
        }),
      })),
    };
    const service = new DockerBuildService(db as never);

    await (service as any).markArtifactRolloutExecuting(
      'build-executing',
      'rollout-a',
      'docker-build:build-executing:attempt:2'
    );

    expect(values.progress).toEqual(rolloutProgress('build-executing', 2, 'executing'));
  });

  it('accepts trailing logs from the assigned builder for a short terminal grace period', () => {
    const completedAt = new Date('2026-08-26T01:00:00.000Z');
    const build = {
      builderNodeId: 'builder-1',
      leaseOwner: null,
      status: 'failed' as DockerBuildStatus,
      completedAt,
    };

    expect(canAcceptDockerBuildLogEvent(build, 'builder-1', new Date(completedAt.getTime() + 1_000))).toBe(true);
    expect(canAcceptDockerBuildLogEvent(build, 'builder-1', new Date(completedAt.getTime() + 5 * 60 * 1000 + 1))).toBe(
      false
    );
    expect(canAcceptDockerBuildLogEvent(build, 'builder-2', new Date(completedAt.getTime() + 1_000))).toBe(false);
  });

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

  it('does not overwrite a concurrent heartbeat during a non-terminal transition', async () => {
    const current = {
      ...queuedBuild('build-transition'),
      status: 'building' as const,
      leaseOwner: 'worker-a',
      leaseHeartbeatAt: new Date('2026-09-01T00:00:00.000Z'),
      leaseExpiresAt: new Date('2026-09-01T00:01:00.000Z'),
    };
    let updateValues: Record<string, unknown> = {};
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [current]) })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updateValues = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...current, ...values, status: 'scanning' }]),
            })),
          };
        }),
      })),
    };
    const service = new DockerBuildService(db as never);

    await service.transition('build-transition', 'worker-a', 'scanning');

    expect(updateValues).not.toHaveProperty('leaseOwner');
    expect(updateValues).not.toHaveProperty('leaseHeartbeatAt');
    expect(updateValues).not.toHaveProperty('leaseExpiresAt');
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
      attempt: 1,
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
    const beginArtifactRollout = vi.spyOn(service, 'beginArtifactRollout').mockResolvedValue({
      ...queuedBuild('build-success'),
      status: 'deploying',
      leaseOwner: 'rollout-a',
      attempt: 1,
      progress: rolloutProgress('build-success'),
    } as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

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
    expect(beginArtifactRollout).toHaveBeenCalledWith('build-success', 'worker-a', 1, {});
    await vi.waitFor(() =>
      expect(rollout).toHaveBeenCalledWith('build-success', 'rollout-a', 'docker-build:build-success:attempt:1')
    );
    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith('build-success', 'rollout-a', 'succeeded'));
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

  it('returns the backend-owned deploying lease before artifact rollout completes', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-early-ack'),
      status: 'scanning',
      attempt: 1,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-a',
      artifact: null,
      sourceAutoDeploy: true,
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);
    const transition = vi.spyOn(service, 'transition').mockImplementation(
      async (_id, _lease, status) =>
        ({
          ...queuedBuild('build-early-ack'),
          status,
        }) as never
    );
    vi.spyOn(service, 'recordArtifact').mockResolvedValue({
      artifact: { policyDecision: 'approved' },
      created: true,
    } as never);
    vi.spyOn(service, 'beginArtifactRollout').mockResolvedValue({
      ...queuedBuild('build-early-ack'),
      status: 'deploying',
      leaseOwner: 'rollout-a',
      attempt: 1,
      progress: rolloutProgress('build-early-ack'),
    } as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
    let completeRollout: ((value: 'deployed') => void) | undefined;
    const rollout = vi.fn(
      () =>
        new Promise<'deployed'>((resolve) => {
          completeRollout = resolve;
        })
    );
    service.setArtifactRollout(rollout);

    const accepted = await service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      buildId: 'build-early-ack',
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
      scanSummaryJson: '{"critical":0,"high":0,"medium":0,"low":0,"unknown":0}',
      policyDecision: 'pending',
      errorCode: '',
      errorMessage: '',
      occurredAtUnixMs: '0',
    });

    expect(accepted).toMatchObject({ status: 'deploying', leaseOwner: 'rollout-a' });
    expect(rollout).toHaveBeenCalledWith('build-early-ack', 'rollout-a', 'docker-build:build-early-ack:attempt:1');
    expect(transition).not.toHaveBeenCalledWith('build-early-ack', 'rollout-a', 'succeeded');

    completeRollout?.('deployed');
    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith('build-early-ack', 'rollout-a', 'succeeded'));
  });

  it('reconciles a Pages success event that races ahead of the scanning status event', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('pages-build-success'),
      status: 'building',
      attempt: 1,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-a',
      artifact: null,
      sourceAutoDeploy: true,
      target: { kind: 'pages_project', pageProjectId: 'page-1' },
    } as never);
    const transition = vi.spyOn(service, 'transition').mockImplementation(
      async (_id, _lease, status) =>
        ({
          ...queuedBuild('pages-build-success'),
          status,
        }) as never
    );
    vi.spyOn(service, 'recordArtifact').mockResolvedValue({
      artifact: { policyDecision: 'approved' },
      created: true,
    } as never);
    const beginArtifactRollout = vi.spyOn(service, 'beginArtifactRollout').mockResolvedValue({
      ...queuedBuild('pages-build-success'),
      status: 'deploying',
      leaseOwner: 'rollout-a',
      attempt: 1,
      progress: rolloutProgress('pages-build-success'),
    } as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

    await service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      buildId: 'pages-build-success',
      status: 'succeeded',
      sequence: '0',
      logChunk: Buffer.alloc(0),
      progressJson: '',
      artifactRepository: 'gateway/builds/pages-source',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      artifactSizeBytes: '1234',
      platform: 'linux/amd64',
      sbomDigest: '',
      provenanceDigest: '',
      scanSummaryJson: '',
      policyDecision: 'pending',
      errorCode: '',
      errorMessage: '',
      occurredAtUnixMs: '0',
    });

    expect(transition).toHaveBeenNthCalledWith(1, 'pages-build-success', 'worker-a', 'scanning');
    expect(transition).toHaveBeenNthCalledWith(2, 'pages-build-success', 'worker-a', 'pushing');
    expect(beginArtifactRollout).toHaveBeenCalledWith('pages-build-success', 'worker-a', 1, {});
    await vi.waitFor(() =>
      expect(rollout).toHaveBeenCalledWith(
        'pages-build-success',
        'rollout-a',
        'docker-build:pages-build-success:attempt:1'
      )
    );
    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith('pages-build-success', 'rollout-a', 'succeeded'));
  });

  it('prepares a Compose revision even when automatic deployment is disabled', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('compose-build'),
      status: 'scanning',
      attempt: 1,
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
    const beginArtifactRollout = vi.spyOn(service, 'beginArtifactRollout').mockResolvedValue({
      ...queuedBuild('compose-build'),
      status: 'deploying',
      leaseOwner: 'rollout-a',
      attempt: 1,
      progress: rolloutProgress('compose-build'),
    } as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
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

    expect(beginArtifactRollout).toHaveBeenCalledWith('compose-build', 'worker-a', 1, {});
    await vi.waitFor(() =>
      expect(rollout).toHaveBeenCalledWith('compose-build', 'rollout-a', 'docker-build:compose-build:attempt:1')
    );
    await vi.waitFor(() => expect(transition).toHaveBeenCalledWith('compose-build', 'rollout-a', 'succeeded'));
  });

  it('rejects a delayed event from an older build attempt', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-attempt'),
      status: 'building',
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-b',
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);

    await expect(
      service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        buildId: 'build-attempt',
        status: 'heartbeat',
        attempt: 1,
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
    ).rejects.toMatchObject({ code: 'BUILD_EVENT_ATTEMPT_STALE' });
  });

  it('rejects a legacy attempt-zero terminal event after the build row is reclaimed', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-legacy-stale'),
      status: 'building',
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'worker-b',
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);
    const transition = vi.spyOn(service, 'transition');

    await expect(
      service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        buildId: 'build-legacy-stale',
        status: 'failed',
        attempt: 0,
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
        errorCode: 'OLD_WORKER_FAILED',
        errorMessage: 'late terminal event',
        occurredAtUnixMs: '0',
      })
    ).rejects.toMatchObject({ code: 'BUILD_EVENT_ATTEMPT_STALE' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('accepts a repeated terminal event for the completed matching attempt', async () => {
    const service = new DockerBuildService({} as never);
    const completed = {
      ...queuedBuild('build-complete'),
      status: 'succeeded' as const,
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: null,
      completedAt: new Date(),
      artifact: { id: 'artifact-1' },
      target: { kind: 'container' as const, nodeId: 'node-1', containerName: 'api' },
    };
    vi.spyOn(service, 'get').mockResolvedValue(completed as never);

    await expect(
      service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        buildId: 'build-complete',
        status: 'succeeded',
        attempt: 2,
        sequence: '0',
        logChunk: Buffer.alloc(0),
        progressJson: '',
        artifactRepository: 'gateway/builds/source',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        artifactSizeBytes: '1234',
        platform: 'linux/amd64',
        sbomDigest: '',
        provenanceDigest: '',
        scanSummaryJson: '',
        policyDecision: 'pending',
        errorCode: '',
        errorMessage: '',
        occurredAtUnixMs: '0',
      })
    ).resolves.toBe(completed);
  });

  it('acknowledges a duplicate terminal event while a backend-owned rollout is already deploying', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-deploying'),
      status: 'deploying',
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:old',
      sourceAutoDeploy: true,
      target: { kind: 'pages_project', pageProjectId: 'page-1' },
    } as never);
    const transition = vi.spyOn(service, 'transition');
    const recordArtifact = vi.spyOn(service, 'recordArtifact');
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

    await service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      buildId: 'build-deploying',
      status: 'succeeded',
      attempt: 2,
      sequence: '0',
      logChunk: Buffer.alloc(0),
      progressJson: '',
      artifactRepository: 'gateway/builds/pages-source',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      artifactSizeBytes: '1234',
      platform: 'linux/amd64',
      sbomDigest: '',
      provenanceDigest: '',
      scanSummaryJson: '',
      policyDecision: 'pending',
      errorCode: '',
      errorMessage: '',
      occurredAtUnixMs: '0',
    });

    expect(recordArtifact).not.toHaveBeenCalled();
    expect(rollout).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('rejects a delayed worker failure after the backend owns the rollout lease', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-deploying-failure'),
      status: 'deploying',
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:current',
      progress: rolloutProgress('build-deploying-failure', 2, 'executing'),
      sourceAutoDeploy: true,
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    } as never);
    const transition = vi.spyOn(service, 'transition');

    await expect(
      service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        buildId: 'build-deploying-failure',
        status: 'failed',
        attempt: 2,
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
        errorCode: 'LATE_FAILURE',
        errorMessage: 'worker disconnected after upload',
        occurredAtUnixMs: '0',
      })
    ).rejects.toMatchObject({ code: 'BUILD_EVENT_TERMINAL_CONFLICT' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not let a worker heartbeat renew a backend-owned rollout lease', async () => {
    const service = new DockerBuildService({} as never);
    const deploying = {
      ...queuedBuild('build-deploying-heartbeat'),
      status: 'deploying' as const,
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:current',
      progress: rolloutProgress('build-deploying-heartbeat', 2, 'executing'),
      target: { kind: 'container', nodeId: 'node-1', containerName: 'api' },
    };
    vi.spyOn(service, 'get').mockResolvedValue(deploying as never);
    const heartbeat = vi.spyOn(service, 'heartbeat');

    await expect(
      service.handleDaemonEvent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        buildId: 'build-deploying-heartbeat',
        status: 'heartbeat',
        attempt: 2,
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
    ).resolves.toBe(deploying);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('reclaims an expired deploying lease and resumes rollout without rebuilding or incrementing attempt', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-recover-rollout'),
      status: 'deploying' as const,
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:old',
      leaseHeartbeatAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: rolloutProgress('build-recover-rollout', 2, 'accepted'),
    };
    let recoveredValues: Record<string, unknown> = {};
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'container', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'container', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          recoveredValues = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...expired, ...values }]),
            })),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);
    const transition = vi
      .spyOn(service, 'transition')
      .mockImplementation(async (_id, _lease, status) => ({ ...expired, status }) as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

    const recovered = await service.recoverExpiredLeases(now);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: 'deploying', attempt: 2, builderNodeId: expired.builderNodeId });
    expect(recoveredValues).not.toHaveProperty('status');
    expect(recoveredValues).not.toHaveProperty('attempt');
    expect(recoveredValues.leaseOwner).toMatch(/^gateway-rollout:/);
    await vi.waitFor(() =>
      expect(rollout).toHaveBeenCalledWith(
        'build-recover-rollout',
        recoveredValues.leaseOwner,
        'docker-build:build-recover-rollout:attempt:2'
      )
    );
    await vi.waitFor(() =>
      expect(transition).toHaveBeenCalledWith('build-recover-rollout', recoveredValues.leaseOwner, 'succeeded')
    );
  });

  it('adds deterministic rollout metadata when recovering a legacy idempotent deployment', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-legacy-pages-rollout'),
      status: 'deploying' as const,
      attempt: 1,
      leaseOwner: 'gateway-rollout:old',
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: {},
    };
    let recoveredValues: Record<string, unknown> = {};
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'pages_project', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          recoveredValues = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...expired, ...values }]),
            })),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);
    vi.spyOn(service as any, 'markArtifactRolloutExecuting').mockResolvedValue(undefined);
    vi.spyOn(service, 'transition').mockResolvedValue({ ...expired, status: 'succeeded' } as never);
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

    await service.recoverExpiredLeases(now);

    expect(recoveredValues.progress).toEqual(rolloutProgress('build-legacy-pages-rollout', 1, 'executing'));
    await vi.waitFor(() =>
      expect(rollout).toHaveBeenCalledWith(
        'build-legacy-pages-rollout',
        recoveredValues.leaseOwner,
        'docker-build:build-legacy-pages-rollout:attempt:1'
      )
    );
  });

  it('refuses to replay an expired ordinary rollout after external execution started', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-interrupted-rollout'),
      status: 'deploying' as const,
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:old',
      leaseHeartbeatAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: rolloutProgress('build-interrupted-rollout', 2, 'executing'),
    };
    let recoveredValues: Record<string, unknown> = {};
    const tx = {
      execute: vi.fn(async () => ({ rows: [{ acquired: true }] })),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'container', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'container', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          recoveredValues = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...expired, ...values }]),
            })),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);
    const rollout = vi.fn().mockResolvedValue('deployed' as const);
    service.setArtifactRollout(rollout);

    const recovered = await service.recoverExpiredLeases(now);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: 'failed', attempt: 2 });
    expect(recoveredValues).toMatchObject({
      status: 'failed',
      errorCode: 'BUILD_ROLLOUT_INTERRUPTED',
      leaseOwner: null,
    });
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(rollout).not.toHaveBeenCalled();
  });

  it('reconciles an interrupted ordinary rollout when its deployed commit was durably recorded', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-committed-rollout'),
      status: 'deploying' as const,
      attempt: 2,
      builderNodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      leaseOwner: 'gateway-rollout:old',
      leaseHeartbeatAt: new Date(now.getTime() - 120_000),
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: rolloutProgress('build-committed-rollout', 2, 'executing'),
    };
    let recoveredValues: Record<string, unknown> = {};
    const tx = {
      execute: vi.fn(async () => ({ rows: [{ acquired: true }] })),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  targetKind: 'deployment',
                  desiredCommitSha: expired.commitSha,
                  deployedCommitSha: expired.commitSha,
                },
              ]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  targetKind: 'deployment',
                  desiredCommitSha: expired.commitSha,
                  deployedCommitSha: expired.commitSha,
                },
              ]),
            })),
          })),
        }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          recoveredValues = values;
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => [{ ...expired, ...values }]),
            })),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);

    const recovered = await service.recoverExpiredLeases(now);

    expect(recovered).toHaveLength(1);
    expect(recoveredValues).toMatchObject({ status: 'succeeded', errorCode: null, leaseOwner: null });
  });

  it('marks a previously deployed commit superseded when the desired commit advanced before recovery', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-superseded-rollout'),
      status: 'deploying' as const,
      attempt: 2,
      leaseOwner: 'gateway-rollout:old',
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: rolloutProgress('build-superseded-rollout', 2, 'executing'),
    };
    const newerCommit = 'b'.repeat(40);
    let recoveredValues: Record<string, unknown> = {};
    const source = {
      targetKind: 'container',
      desiredCommitSha: newerCommit,
      deployedCommitSha: expired.commitSha,
    };
    const tx = {
      execute: vi.fn(async () => ({ rows: [{ acquired: true }] })),
      select: vi
        .fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })) })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [source]) })) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [source]) })) })),
        }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => {
          recoveredValues = values;
          return {
            where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...expired, ...values }]) })),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);

    await service.recoverExpiredLeases(now);

    expect(recoveredValues).toMatchObject({ status: 'superseded', errorCode: null, leaseOwner: null });
  });

  it('does not reclaim an executing ordinary rollout while its source lock is still held', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const expired = {
      ...queuedBuild('build-busy-rollout'),
      status: 'deploying' as const,
      attempt: 2,
      leaseOwner: 'gateway-rollout:old',
      leaseExpiresAt: new Date(now.getTime() - 60_000),
      progress: rolloutProgress('build-busy-rollout', 2, 'executing'),
    };
    const tx = {
      execute: vi.fn(async () => ({ rows: [{ acquired: false }] })),
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({ where: vi.fn(async () => [expired]) })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                { targetKind: 'container', desiredCommitSha: expired.commitSha, deployedCommitSha: null },
              ]),
            })),
          })),
        }),
      update: vi.fn(),
    };
    const db = { transaction: vi.fn((callback: (database: typeof tx) => unknown) => callback(tx)) };
    const service = new DockerBuildService(db as never);

    await expect(service.recoverExpiredLeases(now)).resolves.toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects builder events from a node that does not own the lease', async () => {
    const service = new DockerBuildService({} as never);
    vi.spyOn(service, 'get').mockResolvedValue({
      ...queuedBuild('build-owner'),
      status: 'building',
      attempt: 1,
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
