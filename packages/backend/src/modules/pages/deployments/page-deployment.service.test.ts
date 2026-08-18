import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import { PageDeploymentService, type PageDeployPrincipal } from './page-deployment.service.js';

const mocks = vi.hoisted(() => ({
  validateArchive: vi.fn(),
}));

vi.mock('../artifacts/page-archive-validator.js', () => ({
  validatePageArchive: mocks.validateArchive,
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const DEPLOYMENT_ID = '22222222-2222-4222-8222-222222222222';
const UPLOAD_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const SHA256 = 'a'.repeat(64);

const principal: PageDeployPrincipal = { kind: 'user', userId: USER_ID, scopes: [`pages:deploy:${PROJECT_ID}`] };

function deploymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    sequence: 7,
    publicSlug: 'abcdefghijklmnop',
    previewHostname: null,
    status: 'uploading',
    artifactKey: null,
    artifactSha256: null,
    compressedSizeBytes: 0,
    expandedSizeBytes: 0,
    fileCount: 0,
    sourceMetadata: {},
    idempotencyKey: null,
    requestedTag: null,
    deployTokenId: null,
    pinned: false,
    failureCode: null,
    failureMessage: null,
    createdById: USER_ID,
    createdAt: new Date('2026-08-17T10:00:00Z'),
    updatedAt: new Date('2026-08-17T10:00:00Z'),
    readyAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function serviceDependencies() {
  return {
    audit: { log: vi.fn(async () => {}) },
    settings: { getConfig: vi.fn(async () => ({ fileUploadMaxBytes: 1024 * 1024 })) },
    store: {
      uploadKey: vi.fn(() => `uploads/${UPLOAD_ID}.part`),
      artifactKey: vi.fn(() => `artifacts/${PROJECT_ID}/${DEPLOYMENT_ID}.tar.gz`),
      resolveKey: vi.fn(() => '/tmp/upload.tar.gz'),
      size: vi.fn(async () => 100),
      sha256: vi.fn(async () => SHA256),
      commitUpload: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      appendChunk: vi.fn(),
    },
  };
}

describe('PageDeploymentService', () => {
  it('allocates a monotonic sequence and reserves quota in one transaction', async () => {
    const dependencies = serviceDependencies();
    const deploymentValues = vi.fn();
    let insertCall = 0;
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [
              {
                id: PROJECT_ID,
                storageQuotaBytes: 1000,
                storageUsedBytes: 100,
                nextDeploymentSequence: 8,
              },
            ]),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: vi.fn(async () => [{ reservedBytes: 200 }]) })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values) => {
          insertCall += 1;
          if (insertCall === 1) {
            deploymentValues(values);
            return { returning: vi.fn(async () => [deploymentRow(values as Record<string, unknown>)]) };
          }
          return Promise.resolve();
        }),
      })),
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    const result = await service.create(
      {
        projectId: PROJECT_ID,
        declaredSizeBytes: 300,
        sha256: SHA256,
        source: { commitSha: 'abc123' },
      },
      principal
    );

    expect(result.deployment.sequence).toBe(7);
    expect(deploymentValues).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, sequence: 7, createdById: USER_ID })
    );
    expect(dependencies.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'page_deployment.create',
        details: expect.objectContaining({ declaredSizeBytes: 300, credentialType: 'user' }),
      })
    );
  });

  it('rejects a deployment when used plus reserved storage exceeds the Project quota', async () => {
    const dependencies = serviceDependencies();
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [
              {
                id: PROJECT_ID,
                storageQuotaBytes: 1000,
                storageUsedBytes: 800,
                nextDeploymentSequence: 8,
              },
            ]),
          })),
        })),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: vi.fn(async () => [{ reservedBytes: 150 }]) })),
        })),
      })),
      insert: vi.fn(),
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(
      service.create({ projectId: PROJECT_ID, declaredSizeBytes: 100, sha256: SHA256, source: {} }, principal)
    ).rejects.toMatchObject({ code: 'PAGES_STORAGE_QUOTA_EXCEEDED' });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('returns the existing upload for a repeated Project idempotency key', async () => {
    const dependencies = serviceDependencies();
    const existingDeployment = deploymentRow({ idempotencyKey: 'pipeline-42' });
    const existingSession = {
      id: UPLOAD_ID,
      receivedBytes: 25,
      declaredSizeBytes: 100,
      declaredSha256: SHA256,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [{ deployment: existingDeployment, session: existingSession }]),
            })),
          })),
        })),
      })),
      transaction: vi.fn(),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    const result = await service.create(
      {
        projectId: PROJECT_ID,
        declaredSizeBytes: 100,
        sha256: SHA256,
        idempotencyKey: 'pipeline-42',
        source: {},
      },
      principal
    );

    expect(result.upload).toMatchObject({ id: UPLOAD_ID, offset: 25 });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dependencies.settings.getConfig).not.toHaveBeenCalled();
  });

  it('rejects finalization of an expired upload before claiming it', async () => {
    const dependencies = serviceDependencies();
    const row = {
      deployment: deploymentRow(),
      project: { id: PROJECT_ID, name: 'Docs', storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 100,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey: `uploads/${UPLOAD_ID}.part`,
        expiresAt: new Date(Date.now() - 1),
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
      update: vi.fn(),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(service.finalize(UPLOAD_ID, principal)).rejects.toMatchObject({ code: 'PAGES_UPLOAD_EXPIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects a user without the Project deploy scope from resuming a known upload', async () => {
    const dependencies = serviceDependencies();
    const row = {
      deployment: deploymentRow(),
      project: { id: PROJECT_ID, storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 0,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey: `uploads/${UPLOAD_ID}.part`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(
      service.appendChunk(UPLOAD_ID, 0, new Uint8Array([1]), {
        kind: 'user',
        userId: USER_ID,
        scopes: [],
      })
    ).rejects.toMatchObject({ code: 'PAGE_DEPLOY_FORBIDDEN' });
    expect(dependencies.store.appendChunk).not.toHaveBeenCalled();
  });

  it('requires the same deploy token when resuming', async () => {
    const dependencies = serviceDependencies();
    const row = {
      deployment: deploymentRow({
        createdById: null,
        deployTokenId: 'token-owner',
        requestedTag: 'mr-42',
      }),
      project: { id: PROJECT_ID, storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 0,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey: `uploads/${UPLOAD_ID}.part`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(
      service.finalize(UPLOAD_ID, {
        kind: 'deploy-token',
        token: {
          tokenId: 'token-other',
          tokenPrefix: 'gwp_other',
          projectId: PROJECT_ID,
          allowedTagPatterns: ['mr-*'],
          allowUserTag: true,
        },
      })
    ).rejects.toMatchObject({ code: 'PAGES_UPLOAD_PRINCIPAL_MISMATCH' });
  });

  it('rejects out-of-order finalization while the declared upload is incomplete', async () => {
    const dependencies = serviceDependencies();
    const row = {
      deployment: deploymentRow(),
      project: { id: PROJECT_ID, name: 'Docs', storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 99,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey: `uploads/${UPLOAD_ID}.part`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
      update: vi.fn(),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(service.finalize(UPLOAD_ID, principal)).rejects.toMatchObject({ code: 'PAGES_UPLOAD_INCOMPLETE' });
    expect(db.update).not.toHaveBeenCalled();
    expect(dependencies.store.commitUpload).not.toHaveBeenCalled();
  });

  it('fails and removes a complete upload whose declared SHA-256 does not match', async () => {
    const dependencies = serviceDependencies();
    dependencies.store.sha256.mockResolvedValue('b'.repeat(64));
    const tempKey = `uploads/${UPLOAD_ID}.part`;
    const row = {
      deployment: deploymentRow(),
      project: { id: PROJECT_ID, name: 'Docs', storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 100,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    let updateCall = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => {
            updateCall += 1;
            return { returning: vi.fn(async () => (updateCall === 1 ? [{ id: UPLOAD_ID }] : [])) };
          }),
        })),
      })),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(service.finalize(UPLOAD_ID, principal)).rejects.toMatchObject({
      code: 'PAGES_UPLOAD_CHECKSUM_MISMATCH',
    });
    expect(dependencies.store.remove).toHaveBeenCalledWith(tempKey);
    expect(dependencies.store.commitUpload).not.toHaveBeenCalled();
  });

  it('removes the promoted artifact if the metadata transaction fails', async () => {
    const dependencies = serviceDependencies();
    mocks.validateArchive.mockResolvedValue({ fileCount: 2, expandedSizeBytes: 200 });
    const tempKey = `uploads/${UPLOAD_ID}.part`;
    const artifactKey = `artifacts/${PROJECT_ID}/${DEPLOYMENT_ID}.tar.gz`;
    const row = {
      deployment: deploymentRow(),
      project: { id: PROJECT_ID, name: 'Docs', storageQuotaBytes: 1000 },
      session: {
        id: UPLOAD_ID,
        status: 'open',
        receivedBytes: 100,
        declaredSizeBytes: 100,
        declaredSha256: SHA256,
        tempKey,
        expiresAt: new Date(Date.now() + 60_000),
      },
    };
    let updateCall = 0;
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => [row]) })) })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => {
            updateCall += 1;
            return { returning: vi.fn(async () => (updateCall === 1 ? [{ id: UPLOAD_ID }] : [])) };
          }),
        })),
      })),
      transaction: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    };
    const service = new PageDeploymentService(
      db as unknown as DrizzleClient,
      dependencies.audit as never,
      dependencies.settings as never,
      dependencies.store as unknown as PageArtifactStore
    );

    await expect(service.finalize(UPLOAD_ID, principal)).rejects.toMatchObject({
      code: 'PAGES_DEPLOYMENT_FINALIZE_FAILED',
    });
    expect(dependencies.store.commitUpload).toHaveBeenCalledWith(tempKey, artifactKey);
    expect(dependencies.store.remove).toHaveBeenCalledWith(tempKey);
    expect(dependencies.store.remove).toHaveBeenCalledWith(artifactKey);
    expect(dependencies.audit.log).not.toHaveBeenCalled();
  });
});
