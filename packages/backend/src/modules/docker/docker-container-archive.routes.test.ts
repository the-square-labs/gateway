import 'reflect-metadata';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError, errorHandler } from '@/middleware/error-handler.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import type { AppEnv } from '@/types.js';
import { DockerAvailabilityService } from './availability/docker-availability.service.js';
import { DockerManagementService } from './docker.service.js';
import { registerContainerRoutes } from './docker-container.routes.js';
import { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE_ID = 'archive-container';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

function containerScope(scope: string) {
  return `${scope}:${NODE_ID}/${RESOURCE_ID}`;
}

function imageStream() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('docker-image'));
      controller.close();
    },
  });
}

function setup(scopes: string[]) {
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue({ Name: '/demo', scopeResourceId: RESOURCE_ID }),
    getContainerEnv: vi.fn(),
  };
  const dispatch = {
    openArchiveExport: vi.fn().mockImplementation(async (args: { imageMode: 'portable' | 'registry' }) => ({
      manifest: { schemaVersion: 1, name: 'demo' },
      imageId: IMAGE_ID,
      imageTags: [],
      captureMode: args.imageMode === 'registry' ? 'registry-reference' : 'image',
      imageEmbedded: args.imageMode !== 'registry',
      ...(args.imageMode === 'registry' ? { imagePullReference: `registry.example/demo@${IMAGE_ID}` } : {}),
    })),
    readArchiveImage: vi.fn().mockReturnValue(imageStream()),
    abort: vi.fn().mockResolvedValue({}),
  };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const licensePolicy = { requireFeature: vi.fn().mockResolvedValue(undefined) };
  container.registerInstance(DockerManagementService, docker as never);
  container.registerInstance(DockerAvailabilityService, {
    resolveRuntimeAccessIdentity: vi.fn().mockResolvedValue(null),
  } as never);
  container.registerInstance(DockerMigrationDispatchAdapter, dispatch as never);
  container.registerInstance(AuditService, audit as never);
  container.registerInstance(LicensePolicyService, licensePolicy as never);

  const app = new OpenAPIHono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('effectiveScopes', scopes);
    c.set('user', { id: 'user-1' } as never);
    await next();
  });
  registerContainerRoutes(app);
  return { app, audit, dispatch, docker, licensePolicy };
}

afterEach(() => {
  container.reset();
});

describe('GWCA archive export route', () => {
  it('requires the Personal container archive entitlement before contacting Docker', async () => {
    const { app, dispatch, licensePolicy } = setup([containerScope('docker:containers:export')]);
    licensePolicy.requireFeature.mockRejectedValueOnce(
      new AppError(403, 'LICENSE_ENTITLEMENT_REQUIRED', 'A higher license plan is required')
    );

    const response = await app.request(
      `/nodes/${NODE_ID}/containers/container-id/archive?imageMode=registry&includeEnvironment=false`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'LICENSE_ENTITLEMENT_REQUIRED' });
    expect(dispatch.openArchiveExport).not.toHaveBeenCalled();
  });

  it('requires files only for portable archives', async () => {
    const { app, dispatch } = setup([containerScope('docker:containers:export')]);

    const portable = await app.request(
      `/nodes/${NODE_ID}/containers/container-id/archive?imageMode=portable&includeEnvironment=false`
    );
    expect(portable.status).toBe(403);
    expect(await portable.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('files access'),
    });
    expect(dispatch.openArchiveExport).not.toHaveBeenCalled();

    const registry = await app.request(
      `/nodes/${NODE_ID}/containers/container-id/archive?imageMode=registry&includeEnvironment=false`
    );
    expect(registry.status).toBe(200);
    await registry.arrayBuffer();
    expect(dispatch.openArchiveExport).toHaveBeenCalledWith(
      expect.objectContaining({ imageMode: 'registry', includeEnvironment: false, environment: {}, secrets: {} })
    );
  });

  it('does not read environment or secrets when their export option is disabled', async () => {
    const { app, dispatch, docker } = setup([
      containerScope('docker:containers:export'),
      containerScope('docker:containers:files:read'),
    ]);

    const response = await app.request(
      `/nodes/${NODE_ID}/containers/container-id/archive?imageMode=portable&includeEnvironment=false`
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(docker.getContainerEnv).not.toHaveBeenCalled();
    expect(dispatch.openArchiveExport).toHaveBeenCalledWith(
      expect.objectContaining({
        imageMode: 'portable',
        includeEnvironment: false,
        includeSecrets: false,
        environment: {},
        secrets: {},
        secretKeys: [],
      })
    );
  });
});
