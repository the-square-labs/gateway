import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ContainerArchiveExportQuerySchema, ContainerArchivePlanSchema } from './docker.schemas.js';
import {
  applyGwcaImportResolution,
  GwcaImportReader,
  type GwcaManifest,
  importGwca,
  openGwcaExport,
  stripReservedGwcaLabels,
} from './docker-container-archive.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

const MAGIC = Buffer.from([0x47, 0x57, 0x43, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);

function frame(type: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(payload.length), 1);
  return Buffer.concat([header, payload]);
}

function streamBytes(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function imageFrame(payload: Uint8Array): Buffer {
  const digest = createHash('sha256').update(payload).digest();
  return frame(2, Buffer.concat([digest, payload]));
}

function containerManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    name: 'demo',
    imageReference: 'repo/demo:latest',
    environment: { PUBLIC_VALUE: 'visible' },
    ...overrides,
  };
}

function encodeArchive(manifest: GwcaManifest, image: Buffer): Buffer {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return Buffer.concat([
    MAGIC,
    frame(1, manifestBytes),
    ...(image.length ? [imageFrame(image)] : []),
    frame(
      3,
      Buffer.from(
        JSON.stringify({
          algorithm: 'sha256',
          manifestDigest: createHash('sha256').update(manifestBytes).digest('hex'),
          imageDigest: createHash('sha256').update(image).digest('hex'),
          imageBytes: image.length,
        })
      )
    ),
  ]);
}

function archiveBytes(
  image: Buffer,
  imageId = `sha256:${'a'.repeat(64)}`,
  container: Record<string, unknown> = {}
): Buffer {
  return encodeArchive(
    {
      format: 'gwca',
      version: 1,
      createdAt: new Date(0).toISOString(),
      captureMode: 'image',
      volumes: { contentsIncluded: false },
      container: containerManifest(container),
      image: { id: imageId, tags: [] },
    } as GwcaManifest,
    image
  );
}

function registryArchiveBytes(imageId = `sha256:${'f'.repeat(64)}`): Buffer {
  return encodeArchive(
    {
      format: 'gwca',
      version: 1,
      createdAt: new Date(0).toISOString(),
      captureMode: 'registry-reference',
      volumes: { contentsIncluded: false },
      container: containerManifest({ imageReference: 'registry.example/app:stable' }),
      image: {
        id: imageId,
        tags: ['registry.example/app:stable'],
        embedded: false,
        pullReference: `registry.example/app@sha256:${'1'.repeat(64)}`,
      },
    },
    Buffer.alloc(0)
  );
}

describe('GWCA v1', () => {
  it('validates bounded archive planning metadata', () => {
    expect(
      ContainerArchivePlanSchema.parse({
        networks: [{ name: 'app', driver: 'bridge', createable: true }],
        mounts: [
          {
            type: 'volume',
            source: 'app-data',
            target: '/target',
            readOnly: false,
            driver: 'local',
            labels: { 'com.docker.compose.volume': 'app-data' },
          },
        ],
        ports: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
      })
    ).toMatchObject({
      mounts: [{ labels: { 'com.docker.compose.volume': 'app-data' } }],
      ports: [{ hostPort: 8080 }],
    });
    expect(() => ContainerArchivePlanSchema.parse({ networks: [], mounts: [], ports: [], privileged: true })).toThrow();
  });

  it('does not coerce false query strings to true', () => {
    expect(ContainerArchiveExportQuerySchema.parse({})).toEqual({
      imageMode: 'portable',
      includeWritableLayer: false,
      includeEnvironment: true,
      includeSecrets: false,
    });
    expect(
      ContainerArchiveExportQuerySchema.parse({
        includeWritableLayer: 'false',
        includeEnvironment: 'false',
        includeSecrets: 'false',
      })
    ).toEqual({ imageMode: 'portable', includeWritableLayer: false, includeEnvironment: false, includeSecrets: false });
    expect(
      ContainerArchiveExportQuerySchema.parse({
        includeWritableLayer: 'true',
        includeEnvironment: 'true',
        includeSecrets: 'true',
      })
    ).toEqual({ imageMode: 'portable', includeWritableLayer: true, includeEnvironment: true, includeSecrets: true });
    expect(() =>
      ContainerArchiveExportQuerySchema.parse({ includeEnvironment: 'false', includeSecrets: 'true' })
    ).toThrow('Secrets can only be included when environment is included');
  });

  it('parses a streamed manifest and verifies manifest, image, and footer integrity', async () => {
    const image = Buffer.from('docker-image-stream');
    const archive = archiveBytes(image);
    const reader = new GwcaImportReader(streamBytes(archive));
    expect(await reader.readManifest()).toMatchObject({
      format: 'gwca',
      version: 1,
      container: { schemaVersion: 1, name: 'demo' },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of reader.imageChunks()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(image);
    expect(reader.footer).toMatchObject({
      algorithm: 'sha256',
      imageDigest: createHash('sha256').update(image).digest('hex'),
      imageBytes: image.length,
    });
  });

  it('wraps a live Docker image stream without staging it', async () => {
    const image = Buffer.from('live-docker-image');
    const dispatch = {
      openArchiveExport: vi.fn().mockResolvedValue({
        manifest: containerManifest({ name: 'portable-app' }),
        imageId: `sha256:${'d'.repeat(64)}`,
        imageTags: ['portable-app:latest'],
        captureMode: 'image',
        imageEmbedded: true,
      }),
      readArchiveImage: vi.fn().mockReturnValue(streamBytes(image)),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    const archive = await openGwcaExport({
      dispatch,
      nodeId: 'node-1',
      containerId: 'container-1',
      includeWritableLayer: false,
      imageMode: 'portable',
      environment: { PUBLIC_VALUE: 'visible' },
    });
    expect(archive.filename).toBe('portable-app.gwca');
    const reader = new GwcaImportReader(archive.stream);
    expect(await reader.readManifest()).toMatchObject({ image: { tags: ['portable-app:latest'] } });
    const chunks: Buffer[] = [];
    for await (const chunk of reader.imageChunks()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(image);
    expect(dispatch.openArchiveExport).toHaveBeenCalledWith(
      expect.objectContaining({ environment: { PUBLIC_VALUE: 'visible' }, secrets: {}, includeEnvironment: true })
    );
    expect(dispatch.abort).not.toHaveBeenCalled();
  });

  it('passes an explicit environment exclusion to the daemon', async () => {
    const dispatch = {
      openArchiveExport: vi.fn().mockResolvedValue({
        manifest: containerManifest({ name: 'portable-app', environment: {} }),
        imageId: `sha256:${'d'.repeat(64)}`,
        imageTags: [],
        captureMode: 'image',
        imageEmbedded: true,
      }),
      readArchiveImage: vi.fn().mockReturnValue(streamBytes(Buffer.from('image'))),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    const archive = await openGwcaExport({
      dispatch,
      nodeId: 'node-1',
      containerId: 'container-1',
      includeWritableLayer: true,
      imageMode: 'portable',
      environment: {},
      includeEnvironment: false,
    });
    const reader = new GwcaImportReader(archive.stream);
    expect(await reader.readManifest()).toMatchObject({ container: { environment: {} } });
    for await (const _chunk of reader.imageChunks()) {
      // Consume the stream to close the archive session normally.
    }
    expect(dispatch.openArchiveExport).toHaveBeenCalledWith(
      expect.objectContaining({ environment: {}, secrets: {}, includeEnvironment: false })
    );
  });

  it('aborts a daemon export when its manifest is incompatible', async () => {
    const dispatch = {
      openArchiveExport: vi.fn().mockResolvedValue({ manifest: { schemaVersion: 99 } }),
      readArchiveImage: vi.fn(),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    await expect(
      openGwcaExport({
        dispatch,
        nodeId: 'node-1',
        containerId: 'container-1',
        includeWritableLayer: false,
        imageMode: 'portable',
        environment: {},
      })
    ).rejects.toMatchObject({ code: 'GWCA_DAEMON_INCOMPATIBLE' });
    expect(dispatch.abort).toHaveBeenCalledWith('node-1', expect.any(String));
  });

  it('strips reserved Gateway and Compose ownership labels', () => {
    expect(
      stripReservedGwcaLabels({
        'app.label': 'kept',
        'com.docker.compose.project': 'compose',
        'wiolett.gateway.archive.id': 'archive',
        'wiolett.gateway.deployment.managed': 'true',
        'wiolett.gateway.migration.id': 'migration',
      })
    ).toEqual({ 'app.label': 'kept' });
  });

  it('exports a registry-backed archive without opening an image stream', async () => {
    const dispatch = {
      openArchiveExport: vi.fn().mockResolvedValue({
        manifest: containerManifest({ name: 'thin-app', imageReference: 'registry.example/app:stable' }),
        imageId: `sha256:${'f'.repeat(64)}`,
        imageTags: ['registry.example/app:stable'],
        captureMode: 'registry-reference',
        imageEmbedded: false,
        imagePullReference: `registry.example/app@sha256:${'1'.repeat(64)}`,
      }),
      readArchiveImage: vi.fn(),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    const archive = await openGwcaExport({
      dispatch,
      nodeId: 'node-1',
      containerId: 'container-1',
      includeWritableLayer: false,
      imageMode: 'registry',
      environment: {},
    });
    const reader = new GwcaImportReader(archive.stream);
    expect(await reader.readManifest()).toMatchObject({
      captureMode: 'registry-reference',
      image: { embedded: false, pullReference: expect.stringContaining('@sha256:') },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of reader.imageChunks()) chunks.push(Buffer.from(chunk));
    expect(chunks).toHaveLength(0);
    expect(dispatch.readArchiveImage).not.toHaveBeenCalled();
  });

  it('streams a verified image and passes only the resolved supported manifest to the daemon', async () => {
    const image = Buffer.from('imported-docker-image');
    const imageId = `sha256:${'e'.repeat(64)}`;
    const received: Buffer[] = [];
    const dispatch = {
      planArchiveImport: vi.fn().mockResolvedValue({ conflictingPorts: [] }),
      openArchiveImport: vi.fn().mockResolvedValue(undefined),
      writeArchiveImage: vi.fn().mockImplementation(async (_nodeId, _archiveId, _artifactId, chunks) => {
        for await (const chunk of chunks as AsyncIterable<Uint8Array>) received.push(Buffer.from(chunk));
        return image.length;
      }),
      finishArchiveImport: vi
        .fn()
        .mockResolvedValue({ containerId: 'new-container', containerName: 'restored-app', imageId }),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    const result = await importGwca({
      dispatch,
      nodeId: 'node-2',
      name: 'restored-app',
      body: streamBytes(
        archiveBytes(image, imageId, {
          environment: { PUBLIC_VALUE: 'visible' },
          secrets: { DATABASE_PASSWORD: 'secret' },
          networks: [{ name: 'source-app', driver: 'bridge', createable: true }],
          mounts: [
            {
              type: 'volume',
              source: 'source-external',
              target: '/external',
              readOnly: false,
              driver: 'nfs',
              requiresMapping: true,
            },
          ],
          ports: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
        })
      ),
      resolution: {
        networks: { 'source-app': 'target-app' },
        volumes: { 'source-external': 'target-external' },
        ports: { '8080/tcp:8080': 18080 },
      },
    });
    expect(Buffer.concat(received)).toEqual(image);
    expect(dispatch.finishArchiveImport).toHaveBeenCalledWith(
      'node-2',
      expect.any(String),
      'image',
      expect.objectContaining({
        name: 'restored-app',
        manifest: expect.objectContaining({
          networks: [expect.objectContaining({ name: 'target-app' })],
          mounts: [expect.objectContaining({ source: 'target-external', requiresMapping: false })],
          ports: [expect.objectContaining({ hostPort: 18080 })],
        }),
        expectedArtifactDigest: createHash('sha256').update(image).digest('hex'),
      })
    );
    expect(result).toEqual({
      archiveId: expect.any(String),
      containerId: 'new-container',
      containerName: 'restored-app',
      imageId,
      environment: { PUBLIC_VALUE: 'visible' },
      secrets: { DATABASE_PASSWORD: 'secret' },
      createdVolumes: [],
    });
    expect(dispatch.abort).not.toHaveBeenCalled();
  });

  it('rejects archive imports that contain host bind mounts', async () => {
    const dispatch = {
      planArchiveImport: vi.fn(),
      openArchiveImport: vi.fn(),
    } as unknown as DockerMigrationDispatchAdapter;

    await expect(
      importGwca({
        dispatch,
        nodeId: 'node-2',
        name: 'restored-app',
        body: streamBytes(
          archiveBytes(Buffer.from('image'), undefined, {
            mounts: [{ type: 'bind', source: '/source/data', target: '/data', readOnly: false }],
          })
        ),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: 'HOST_BIND_MOUNTS_DISABLED' });
    expect(dispatch.planArchiveImport).not.toHaveBeenCalled();
    expect(dispatch.openArchiveImport).not.toHaveBeenCalled();
  });

  it('rejects occupied host ports before opening the archive import stream', async () => {
    const dispatch = {
      planArchiveImport: vi.fn().mockResolvedValue({ conflictingPorts: ['8080/tcp:8080'] }),
      openArchiveImport: vi.fn(),
    } as unknown as DockerMigrationDispatchAdapter;

    await expect(
      importGwca({
        dispatch,
        nodeId: 'node-2',
        name: 'restored-app',
        body: streamBytes(
          archiveBytes(Buffer.from('image'), undefined, {
            ports: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
          })
        ),
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'GWCA_PORT_CONFLICT',
      details: { conflictingPorts: ['8080/tcp:8080'] },
    });
    expect(dispatch.openArchiveImport).not.toHaveBeenCalled();
  });

  it('rejects resolution keys that are not present in the archive', () => {
    const manifest = {
      format: 'gwca',
      version: 1,
      createdAt: new Date(0).toISOString(),
      captureMode: 'image',
      volumes: { contentsIncluded: false },
      container: containerManifest({ networks: [{ name: 'bridge', createable: false }] }),
      image: { id: `sha256:${'a'.repeat(64)}`, tags: [] },
    } as GwcaManifest;
    expect(() => applyGwcaImportResolution(manifest, { networks: { missing: 'bridge' } })).toThrow(
      'Archive network remapping is invalid'
    );
  });

  it('marks networks and volumes selected for creation', () => {
    const manifest = {
      format: 'gwca',
      version: 1,
      createdAt: new Date(0).toISOString(),
      captureMode: 'image',
      volumes: { contentsIncluded: false },
      container: containerManifest({
        networks: [{ name: 'source-network', driver: 'bridge', createable: false, requiresMapping: true }],
        mounts: [
          {
            type: 'volume',
            source: 'source-volume',
            target: '/data',
            readOnly: false,
            driver: 'rexray/s3fs',
            requiresMapping: true,
          },
        ],
      }),
      image: { id: `sha256:${'a'.repeat(64)}`, tags: [] },
    } as GwcaManifest;

    applyGwcaImportResolution(manifest, {
      networks: { 'source-network': 'source-network' },
      createNetworks: ['source-network'],
      createVolumes: ['source-volume'],
    });

    expect(manifest.container.networks).toEqual([
      expect.objectContaining({
        name: 'source-network',
        createable: true,
        createNew: true,
        requiresMapping: false,
      }),
    ]);
    expect(manifest.container.mounts).toEqual([
      expect.objectContaining({
        source: 'source-volume',
        driver: 'rexray/s3fs',
        createNew: true,
        requiresMapping: false,
      }),
    ]);
  });

  it('rejects legacy or raw Docker fields outside the GWCA whitelist', async () => {
    const reader = new GwcaImportReader(
      streamBytes(
        archiveBytes(Buffer.from('image'), undefined, {
          hostConfig: { Privileged: true },
        })
      )
    );
    await expect(reader.readManifest()).rejects.toMatchObject({ code: 'GWCA_UNSUPPORTED' });
  });

  it('imports a registry-backed archive using target registry credentials', async () => {
    const imageId = `sha256:${'f'.repeat(64)}`;
    const dispatch = {
      planArchiveImport: vi.fn().mockResolvedValue({ conflictingPorts: [] }),
      openArchiveImport: vi.fn().mockResolvedValue(undefined),
      writeArchiveImage: vi.fn(),
      finishArchiveImport: vi
        .fn()
        .mockResolvedValue({ containerId: 'thin-container', containerName: 'thin-app', imageId }),
      abort: vi.fn().mockResolvedValue({}),
    } as unknown as DockerMigrationDispatchAdapter;
    const resolveRegistryAuthCandidates = vi.fn().mockResolvedValue(['auth-json']);
    const result = await importGwca({
      dispatch,
      nodeId: 'node-2',
      name: 'thin-app',
      body: streamBytes(registryArchiveBytes(imageId)),
      resolveRegistryAuthCandidates,
    });
    expect(resolveRegistryAuthCandidates).toHaveBeenCalledWith(`registry.example/app@sha256:${'1'.repeat(64)}`);
    expect(dispatch.openArchiveImport).toHaveBeenCalledWith(
      'node-2',
      expect.any(String),
      'image',
      expect.objectContaining({
        expectedImageId: imageId,
        imageEmbedded: false,
        registryAuthCandidates: ['auth-json'],
      })
    );
    expect(dispatch.writeArchiveImage).not.toHaveBeenCalled();
    expect(result).toEqual({
      archiveId: expect.any(String),
      containerId: 'thin-container',
      containerName: 'thin-app',
      imageId,
      environment: { PUBLIC_VALUE: 'visible' },
      secrets: {},
      createdVolumes: [],
    });
  });

  it('rejects archives whose manifest changes without a matching footer digest', async () => {
    const archive = archiveBytes(Buffer.from('image'));
    const manifestLength = Number(archive.readBigUInt64BE(MAGIC.length + 1));
    const manifestStart = MAGIC.length + 9;
    const manifest = JSON.parse(archive.subarray(manifestStart, manifestStart + manifestLength).toString('utf8'));
    manifest.container.name = 'tampered';
    const invalid = Buffer.concat([
      MAGIC,
      frame(1, Buffer.from(JSON.stringify(manifest))),
      archive.subarray(manifestStart + manifestLength),
    ]);
    const reader = new GwcaImportReader(streamBytes(invalid));
    await reader.readManifest();
    await expect(async () => {
      for await (const _chunk of reader.imageChunks()) {
        /* consume */
      }
    }).rejects.toMatchObject({ code: 'GWCA_CHECKSUM_MISMATCH' });
  });

  it('rejects a corrupted image stream', async () => {
    const archive = archiveBytes(Buffer.from('original'));
    const imageFrameStart = MAGIC.length + 9 + Number(archive.readBigUInt64BE(MAGIC.length + 1));
    const corrupted = Buffer.from(archive);
    corrupted[imageFrameStart + 9 + 32] = 'x'.charCodeAt(0);
    const reader = new GwcaImportReader(streamBytes(corrupted));
    await reader.readManifest();
    await expect(async () => {
      for await (const _chunk of reader.imageChunks()) {
        /* consume */
      }
    }).rejects.toMatchObject({ code: 'GWCA_CHECKSUM_MISMATCH' });
  });

  it('rejects trailing data after the footer', async () => {
    const archive = Buffer.concat([archiveBytes(Buffer.from('image')), Buffer.from('trailing')]);
    const reader = new GwcaImportReader(streamBytes(archive));
    await reader.readManifest();
    await expect(async () => {
      for await (const _chunk of reader.imageChunks()) {
        /* consume */
      }
    }).rejects.toMatchObject({ code: 'GWCA_INVALID' });
  });
});
