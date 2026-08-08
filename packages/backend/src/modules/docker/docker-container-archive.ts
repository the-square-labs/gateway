import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '@/middleware/error-handler.js';
import {
  type GwcaContainerManifest,
  GwcaContainerSchema,
  type GwcaImportResolution,
  type GwcaManifest,
  GwcaManifestSchema,
  stripReservedGwcaLabels,
} from './docker-container-archive-format.js';
import type { DockerMigrationDispatchAdapter } from './docker-migration-dispatch.js';

export type { GwcaContainerManifest, GwcaImportResolution, GwcaManifest } from './docker-container-archive-format.js';
export { stripReservedGwcaLabels } from './docker-container-archive-format.js';

const MAGIC = Buffer.from([0x47, 0x57, 0x43, 0x41, 0x0d, 0x0a, 0x1a, 0x0a]);
const FRAME_MANIFEST = 1;
const FRAME_IMAGE = 2;
const FRAME_FOOTER = 3;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_CHUNK_BYTES = 1024 * 1024;
const MAX_FOOTER_BYTES = 16 * 1024;
const SHA256_BYTES = 32;
const IMAGE_ARTIFACT_ID = 'image';
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface GwcaFooter {
  algorithm: 'sha256';
  manifestDigest: string;
  imageDigest: string;
  imageBytes: number;
}

function frame(type: number, payload: Uint8Array): Uint8Array {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 1);
  return Buffer.concat([header, payload]);
}

export async function openGwcaExport(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  containerId: string;
  includeWritableLayer: boolean;
  imageMode: 'portable' | 'registry';
  environment: Record<string, string>;
  secrets?: Record<string, string>;
  secretKeys?: string[];
  includeEnvironment?: boolean;
  includeSecrets?: boolean;
}): Promise<{ archiveId: string; filename: string; stream: ReadableStream<Uint8Array> }> {
  const archiveId = randomUUID();
  const detail = await args.dispatch.openArchiveExport({
    nodeId: args.nodeId,
    archiveId,
    artifactId: IMAGE_ARTIFACT_ID,
    containerId: args.containerId,
    includeWritableLayer: args.includeWritableLayer,
    imageMode: args.imageMode,
    environment: args.environment,
    secrets: args.secrets ?? {},
    secretKeys: args.secretKeys ?? [],
    includeEnvironment: args.includeEnvironment !== false,
    includeSecrets: args.includeSecrets === true,
  });
  try {
    const parsedContainer = GwcaContainerSchema.safeParse(detail.manifest);
    if (!parsedContainer.success) {
      throw new AppError(
        409,
        'GWCA_DAEMON_INCOMPATIBLE',
        'The Docker daemon does not support the current Gateway container archive format. Update or restart the daemon and try again.'
      );
    }
    const container = parsedContainer.data;
    const name =
      String(container.name || 'container')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 96) || 'container';
    const manifest: GwcaManifest = {
      format: 'gwca',
      version: 1,
      createdAt: new Date().toISOString(),
      captureMode:
        detail.captureMode === 'container-commit-no-pause'
          ? 'container-commit-no-pause'
          : detail.captureMode === 'registry-reference'
            ? 'registry-reference'
            : 'image',
      volumes: { contentsIncluded: false },
      container,
      image: {
        id: String(detail.imageId || ''),
        tags: Array.isArray(detail.imageTags) ? detail.imageTags.map(String) : [],
        embedded: detail.imageEmbedded !== false,
        ...(detail.imagePullReference ? { pullReference: String(detail.imagePullReference) } : {}),
      },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
    const imageReader =
      manifest.image.embedded === false
        ? null
        : args.dispatch.readArchiveImage(args.nodeId, archiveId, IMAGE_ARTIFACT_ID).getReader();
    const hasher = createHash('sha256');
    let imageBytes = 0;
    let started = false;
    let closed = false;
    const abort = () => {
      if (closed) return;
      closed = true;
      void imageReader?.cancel();
      void args.dispatch.abort(args.nodeId, archiveId).catch(() => undefined);
    };
    return {
      archiveId,
      filename: `${name}.gwca`,
      stream: new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (!started) {
              started = true;
              controller.enqueue(MAGIC);
              controller.enqueue(frame(FRAME_MANIFEST, manifestBytes));
              return;
            }
            if (!imageReader) {
              const footer: GwcaFooter = {
                algorithm: 'sha256',
                manifestDigest,
                imageDigest: createHash('sha256').digest('hex'),
                imageBytes: 0,
              };
              controller.enqueue(frame(FRAME_FOOTER, Buffer.from(JSON.stringify(footer))));
              closed = true;
              controller.close();
              return;
            }
            const next = await imageReader.read();
            if (!next.done) {
              hasher.update(next.value);
              imageBytes += next.value.byteLength;
              const chunkDigest = createHash('sha256').update(next.value).digest();
              controller.enqueue(frame(FRAME_IMAGE, Buffer.concat([chunkDigest, next.value])));
              return;
            }
            const footer: GwcaFooter = {
              algorithm: 'sha256',
              manifestDigest,
              imageDigest: hasher.digest('hex'),
              imageBytes,
            };
            controller.enqueue(frame(FRAME_FOOTER, Buffer.from(JSON.stringify(footer))));
            closed = true;
            controller.close();
          } catch (error) {
            abort();
            controller.error(error);
          }
        },
        cancel: abort,
      }),
    };
  } catch (error) {
    await args.dispatch.abort(args.nodeId, archiveId).catch(() => undefined);
    throw error;
  }
}

class StreamBytes {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = Buffer.alloc(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async readExactly(length: number): Promise<Buffer> {
    while (this.buffered.length < length) {
      const next = await this.reader.read();
      if (next.done) throw new AppError(400, 'GWCA_TRUNCATED', 'Container archive is truncated');
      this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  async assertEnd(): Promise<void> {
    if (this.buffered.length > 0) throw new AppError(400, 'GWCA_INVALID', 'Container archive has trailing data');
    const next = await this.reader.read();
    if (!next.done) throw new AppError(400, 'GWCA_INVALID', 'Container archive has trailing data');
  }
}

export class GwcaImportReader {
  private bytes: StreamBytes;
  footer: GwcaFooter | null = null;
  private hasher = createHash('sha256');
  private imageBytes = 0;
  private manifestDigest = '';

  constructor(stream: ReadableStream<Uint8Array>) {
    this.bytes = new StreamBytes(stream);
  }

  private async readFrame(maxLength: number): Promise<{ type: number; payload: Buffer }> {
    const header = await this.bytes.readExactly(9);
    const length = Number(header.readBigUInt64BE(1));
    if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
      throw new AppError(413, 'GWCA_FRAME_TOO_LARGE', 'Container archive frame exceeds the allowed size');
    }
    return { type: header[0]!, payload: await this.bytes.readExactly(length) };
  }

  async readManifest(): Promise<GwcaManifest> {
    const magic = await this.bytes.readExactly(MAGIC.length);
    if (!magic.equals(MAGIC)) throw new AppError(400, 'GWCA_INVALID', 'File is not a Gateway container archive');
    const next = await this.readFrame(MAX_MANIFEST_BYTES);
    if (next.type !== FRAME_MANIFEST) throw new AppError(400, 'GWCA_INVALID', 'Container archive manifest is missing');
    this.manifestDigest = createHash('sha256').update(next.payload).digest('hex');
    let parsed: unknown;
    try {
      parsed = JSON.parse(next.payload.toString('utf8'));
    } catch {
      throw new AppError(400, 'GWCA_INVALID', 'Container archive manifest is invalid');
    }
    const manifest = GwcaManifestSchema.safeParse(parsed);
    if (!manifest.success) {
      throw new AppError(400, 'GWCA_UNSUPPORTED', 'Unsupported or incomplete Gateway container archive');
    }
    manifest.data.container.labels = stripReservedGwcaLabels(manifest.data.container.labels);
    return manifest.data;
  }

  async *imageChunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = await this.readFrame(Math.max(MAX_IMAGE_CHUNK_BYTES + SHA256_BYTES, MAX_FOOTER_BYTES));
      if (next.type === FRAME_IMAGE) {
        if (next.payload.length <= SHA256_BYTES) {
          throw new AppError(400, 'GWCA_INVALID', 'Container archive image frame is empty');
        }
        const expectedChunkDigest = next.payload.subarray(0, SHA256_BYTES);
        const imageChunk = next.payload.subarray(SHA256_BYTES);
        const actualChunkDigest = createHash('sha256').update(imageChunk).digest();
        if (!expectedChunkDigest.equals(actualChunkDigest)) {
          throw new AppError(400, 'GWCA_CHECKSUM_MISMATCH', 'Container archive image chunk checksum does not match');
        }
        this.hasher.update(imageChunk);
        this.imageBytes += imageChunk.length;
        yield imageChunk;
        continue;
      }
      if (next.type !== FRAME_FOOTER) throw new AppError(400, 'GWCA_INVALID', 'Unexpected container archive frame');
      if (next.payload.length > MAX_FOOTER_BYTES) {
        throw new AppError(413, 'GWCA_FRAME_TOO_LARGE', 'Container archive footer exceeds the allowed size');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(next.payload.toString('utf8'));
      } catch {
        throw new AppError(400, 'GWCA_INVALID', 'Container archive footer is invalid');
      }
      const footer = parsed as Partial<GwcaFooter> | null;
      const actual = this.hasher.digest('hex');
      if (
        !footer ||
        footer.algorithm !== 'sha256' ||
        !SHA256_HEX.test(footer.manifestDigest ?? '') ||
        footer.manifestDigest !== this.manifestDigest ||
        !SHA256_HEX.test(footer.imageDigest ?? '') ||
        footer.imageDigest !== actual ||
        !Number.isSafeInteger(footer.imageBytes) ||
        footer.imageBytes !== this.imageBytes
      ) {
        throw new AppError(400, 'GWCA_CHECKSUM_MISMATCH', 'Container archive checksum does not match');
      }
      await this.bytes.assertEnd();
      this.footer = footer as GwcaFooter;
      return;
    }
  }
}

export async function importGwca(args: {
  dispatch: DockerMigrationDispatchAdapter;
  nodeId: string;
  name: string;
  body: ReadableStream<Uint8Array>;
  resolution?: GwcaImportResolution;
  authorizeContents?: (container: GwcaContainerManifest) => void | Promise<void>;
  resolveRegistryAuthCandidates?: (imageReference: string) => Promise<string[]>;
}): Promise<{
  archiveId: string;
  containerId: string;
  containerName: string;
  imageId: string;
  environment: Record<string, string>;
  secrets: Record<string, string>;
}> {
  const archiveId = randomUUID();
  const reader = new GwcaImportReader(args.body);
  const manifest = await reader.readManifest();
  applyGwcaImportResolution(manifest, args.resolution ?? {});
  await args.authorizeContents?.(manifest.container);
  const plan = await args.dispatch.planArchiveImport(args.nodeId, {
    manifest: manifest.container,
    canViewNetworks: false,
    canCreateNetworks: false,
    canViewVolumes: false,
    canCreateVolumes: false,
  });
  if (plan.conflictingPorts.length > 0) {
    throw new AppError(
      409,
      'GWCA_PORT_CONFLICT',
      'Archive host ports are occupied. Remap the conflicting bindings to port 0.',
      { conflictingPorts: plan.conflictingPorts }
    );
  }
  const imageEmbedded = manifest.image.embedded !== false;
  const registryAuthCandidates =
    !imageEmbedded && manifest.image.pullReference && args.resolveRegistryAuthCandidates
      ? await args.resolveRegistryAuthCandidates(manifest.image.pullReference)
      : [];
  await args.dispatch.openArchiveImport(args.nodeId, archiveId, IMAGE_ARTIFACT_ID, {
    expectedImageId: manifest.image.id,
    imageEmbedded,
    ...(manifest.image.pullReference ? { pullReference: manifest.image.pullReference } : {}),
    ...(registryAuthCandidates.length ? { registryAuthCandidates } : {}),
  });
  try {
    if (imageEmbedded) {
      await args.dispatch.writeArchiveImage(args.nodeId, archiveId, IMAGE_ARTIFACT_ID, reader.imageChunks());
    } else {
      for await (const _chunk of reader.imageChunks()) {
        throw new AppError(400, 'GWCA_INVALID', 'Registry-backed container archive contains image data');
      }
    }
    if (!reader.footer) throw new AppError(400, 'GWCA_TRUNCATED', 'Container archive footer is missing');
    const imported = await args.dispatch.finishArchiveImport(args.nodeId, archiveId, IMAGE_ARTIFACT_ID, {
      manifest: manifest.container,
      name: args.name,
      expectedArtifactDigest: reader.footer.imageDigest,
    });
    return {
      archiveId,
      ...imported,
      containerName: imported.containerName || args.name,
      environment: manifest.container.environment ?? {},
      secrets: manifest.container.secrets ?? {},
    };
  } catch (error) {
    await args.dispatch.abort(args.nodeId, archiveId).catch(() => undefined);
    throw error;
  }
}

export function gwcaPortKey(port: { containerPort: number; hostPort: number; protocol: string }): string {
  return `${port.containerPort}/${port.protocol}:${port.hostPort}`;
}

export function applyGwcaImportResolution(manifest: GwcaManifest, resolution: GwcaImportResolution): void {
  const networkNames = new Set((manifest.container.networks ?? []).map((entry) => entry.name));
  const bindSources = new Set(
    (manifest.container.mounts ?? []).filter((entry) => entry.type === 'bind').map((entry) => entry.source)
  );
  const volumeSources = new Set(
    (manifest.container.mounts ?? []).filter((entry) => entry.type === 'volume').map((entry) => entry.source)
  );
  const portKeys = new Set((manifest.container.ports ?? []).map(gwcaPortKey));
  assertResolutionKeys(resolution.networks, networkNames, 'network');
  assertResolutionList(resolution.createNetworks, networkNames, 'network');
  assertResolutionKeys(resolution.bindPaths, bindSources, 'bind path');
  assertResolutionKeys(resolution.volumes, volumeSources, 'volume');
  assertResolutionList(resolution.createVolumes, volumeSources, 'volume');
  assertResolutionKeys(resolution.ports, portKeys, 'port');

  const createNetworks = new Set(resolution.createNetworks ?? []);
  const createVolumes = new Set(resolution.createVolumes ?? []);

  manifest.container.networks = (manifest.container.networks ?? []).map((entry) => ({
    ...entry,
    name: resolution.networks?.[entry.name] ?? entry.name,
    createable: createNetworks.has(entry.name) ? true : entry.createable,
    createNew: createNetworks.has(entry.name),
    requiresMapping: createNetworks.has(entry.name) ? false : entry.requiresMapping,
    subnet: createNetworks.has(entry.name) ? undefined : entry.subnet,
    gateway: createNetworks.has(entry.name) ? undefined : entry.gateway,
  }));
  manifest.container.mounts = (manifest.container.mounts ?? []).map((entry) => {
    if (entry.type === 'bind') {
      return { ...entry, source: resolution.bindPaths?.[entry.source] ?? entry.source };
    }
    if (createVolumes.has(entry.source)) {
      return { ...entry, createNew: true, requiresMapping: false };
    }
    const mapped = resolution.volumes?.[entry.source];
    return mapped ? { ...entry, source: mapped, createNew: false, requiresMapping: false } : entry;
  });
  manifest.container.ports = (manifest.container.ports ?? []).map((entry) => {
    const mapped = resolution.ports?.[gwcaPortKey(entry)];
    if (mapped === undefined) return entry;
    if (!Number.isInteger(mapped) || mapped < 0 || mapped > 65535) {
      throw new AppError(400, 'GWCA_RESOLUTION_INVALID', 'Archive port remapping is invalid');
    }
    return { ...entry, hostPort: mapped };
  });
}

function assertResolutionList(values: string[] | undefined, available: Set<string>, kind: string): void {
  for (const source of values ?? []) {
    if (!available.has(source)) {
      throw new AppError(400, 'GWCA_RESOLUTION_INVALID', `Archive ${kind} creation is invalid`);
    }
  }
}

function assertResolutionKeys(values: Record<string, unknown> | undefined, available: Set<string>, kind: string): void {
  for (const [source, target] of Object.entries(values ?? {})) {
    if (!available.has(source) || (typeof target === 'string' && !target.trim())) {
      throw new AppError(400, 'GWCA_RESOLUTION_INVALID', `Archive ${kind} remapping is invalid`);
    }
  }
}
