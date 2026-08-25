import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageBuildRolloutService } from './page-build-rollout.service.js';

const commitSha = 'a'.repeat(40);
const layerDigest = `sha256:${'b'.repeat(64)}`;

function joinedBuild(overrides: { desiredCommitSha?: string | null } = {}) {
  return {
    build: {
      id: 'build-1',
      commitSha,
      createdById: 'user-1',
      platform: 'linux/amd64',
      repositoryFullPath: 'platform/site',
      ref: 'refs/heads/main',
    },
    source: {
      id: 'source-1',
      targetKind: 'pages_project',
      pageProjectId: 'page-project-1',
      publishTag: 'production',
      desiredCommitSha: overrides.desiredCommitSha ?? commitSha,
      updatedById: null,
      createdById: 'user-1',
    },
    artifact: {
      registryRepository: 'gateway/builds/source-1',
      digest: `sha256:${'c'.repeat(64)}`,
      policyDecision: 'approved',
      status: 'ready',
    },
  };
}

function buildLookupDb(joined: ReturnType<typeof joinedBuild>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn(async () => [joined]) })),
          })),
        })),
      })),
    })),
  };
}

describe('PageBuildRolloutService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not import an artifact after a newer commit supersedes the build', async () => {
    const db = buildLookupDb(joinedBuild({ desiredCommitSha: 'd'.repeat(40) }));
    const tokens = { issueToken: vi.fn() };
    const deployments = { create: vi.fn() };
    const service = new PageBuildRolloutService(db as never, tokens as never, deployments as never, {} as never);

    await expect(service.rollout('build-1')).resolves.toBe('superseded');
    expect(tokens.issueToken).not.toHaveBeenCalled();
    expect(deployments.create).not.toHaveBeenCalled();
  });

  it('rejects registry artifacts that are not a single gzip layer', async () => {
    const db = buildLookupDb(joinedBuild());
    const tokens = { issueToken: vi.fn(() => ({ token: 'registry-token' })) };
    const deployments = { create: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              layers: [
                { digest: layerDigest, size: 3, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' },
                {
                  digest: `sha256:${'e'.repeat(64)}`,
                  size: 4,
                  mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
                },
              ],
            })
          )
      )
    );
    const service = new PageBuildRolloutService(db as never, tokens as never, deployments as never, {} as never);

    await expect(service.rollout('build-1')).rejects.toMatchObject({ code: 'PAGES_BUILD_LAYER_INVALID' });
    expect(deployments.create).not.toHaveBeenCalled();
  });

  it('streams the immutable layer through the existing Pages deployment pipeline', async () => {
    const joined = joinedBuild();
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => [{ desiredCommitSha: commitSha }]) })),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    };
    const db = {
      ...buildLookupDb(joined),
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const tokens = { issueToken: vi.fn(() => ({ token: 'registry-token' })) };
    const deployments = {
      create: vi.fn(async () => ({
        deployment: { id: 'deployment-1', status: 'uploading' },
        upload: { id: 'upload-1', offset: 0 },
      })),
      appendChunk: vi.fn(async (_uploadId: string, offset: number, bytes: Uint8Array) => ({
        offset: offset + bytes.byteLength,
      })),
      finalize: vi.fn(async () => undefined),
      abortUpload: vi.fn(async () => undefined),
    };
    const publication = { markDeploymentReady: vi.fn(async () => undefined) };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            layers: [{ digest: layerDigest, size: 3, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip' }],
          })
        )
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    const service = new PageBuildRolloutService(
      db as never,
      tokens as never,
      deployments as never,
      publication as never
    );

    await expect(service.rollout('build-1')).resolves.toBe('deployed');
    expect(deployments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'page-project-1',
        declaredSizeBytes: 3,
        sha256: 'b'.repeat(64),
        idempotencyKey: 'pages-build:build-1',
        tag: 'production',
      }),
      expect.objectContaining({ kind: 'user', userId: 'user-1' })
    );
    expect(deployments.appendChunk).toHaveBeenCalledWith(
      'upload-1',
      0,
      expect.any(Uint8Array),
      expect.objectContaining({ userId: 'user-1' })
    );
    expect(deployments.finalize).toHaveBeenCalledWith('upload-1', expect.objectContaining({ userId: 'user-1' }));
    expect(publication.markDeploymentReady).toHaveBeenCalledWith('deployment-1');
    expect(tx.update).toHaveBeenCalledOnce();
  });
});
