import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceCoreStateRow } from '@/db/schema/inference-core.js';
import type { TrustedOpenCodexImageArtifact } from '@/lib/update-artifact-trust.js';
import type { DockerContainerFullInspect, DockerCreateContainerConfig } from '@/services/docker.service.js';
import {
  INFERENCE_CORE_PROTOCOL_MAJOR,
  INFERENCE_CORE_STATE_SCHEMA_VERSION,
  type InferenceCoreOperation,
} from './inference-core.contract.js';
import {
  buildSingleFileTar,
  type InferenceCoreCredentials,
  InferenceCoreRuntimeService,
} from './inference-core-runtime.service.js';

const IMAGE = 'registry.test/wiolett/gateway/opencodex';
const OLD_DIGEST = `sha256:${'11'.repeat(32)}`;
const NEW_DIGEST = `sha256:${'22'.repeat(32)}`;
const OLD_VERSION = '2.25.0-wiolett.9';
const NEW_VERSION = '2.26.0-wiolett.1';

const artifact: TrustedOpenCodexImageArtifact = {
  payload: {} as TrustedOpenCodexImageArtifact['payload'],
  signedManifest: '{}',
  imageRef: `${IMAGE}@${NEW_DIGEST}`,
  digest: NEW_DIGEST,
  version: NEW_VERSION,
  sizeBytes: 400_000_000,
  coreProtocolMajor: INFERENCE_CORE_PROTOCOL_MAJOR,
  stateSchemaVersion: INFERENCE_CORE_STATE_SCHEMA_VERSION,
};

const _oldArtifact: TrustedOpenCodexImageArtifact = {
  ...artifact,
  imageRef: `${IMAGE}@${OLD_DIGEST}`,
  digest: OLD_DIGEST,
  version: OLD_VERSION,
};

vi.mock('./inference-core.manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inference-core.manifest.js')>();
  return {
    ...actual,
    fetchLatestOpenCodexTag: vi.fn(async () => `v${NEW_VERSION}`),
    fetchOpenCodexImageManifest: vi.fn(async () => artifact),
    checkOpenCodexGatewayCompatibility: vi.fn(() => ({ compatible: true, reason: null })),
  };
});

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  running: boolean;
  config: DockerCreateContainerConfig;
}

function makeDocker() {
  const containers = new Map<string, FakeContainer>();
  const images: Array<{ Id: string; RepoTags?: string[]; RepoDigests?: string[] }> = [];
  let sequence = 0;
  const calls: string[] = [];
  const docker = {
    calls,
    containers,
    images,
    failNextReplace: false,
    failBackup: false,
    inspectSelf: async (): Promise<DockerContainerFullInspect> => ({
      Id: 'self',
      Name: '/gw-app-1',
      Config: {
        Image: 'registry.test/wiolett/gateway:2.8.0',
        Labels: { 'com.docker.compose.project': 'gw', 'com.docker.compose.service': 'app' },
        Env: [],
      },
      State: { Status: 'running', Running: true, StartedAt: '' },
      NetworkSettings: { Networks: { gw_default: { Aliases: ['app', 'gw-app-1'] } } },
    }),
    listLocalContainers: async () =>
      [...containers.values()].map((c) => ({
        Id: c.id,
        Names: [c.name],
        Image: c.image,
        State: c.running ? 'running' : 'exited',
        Status: '',
        Labels: c.labels,
      })),
    listContainersByLabel: async (label: string) => {
      const [key, value] = label.split('=');
      return [...containers.values()]
        .filter((c) => c.labels[key] === value)
        .map((c) => ({
          Id: c.id,
          Names: [c.name],
          Image: c.image,
          State: c.running ? 'running' : 'exited',
          Status: '',
          Labels: c.labels,
        }));
    },
    imageExists: async () => false,
    listImages: async () => images,
    pullImageRefStreaming: async (_ref: string, onProgress?: (p: object) => void) => {
      calls.push('pull');
      onProgress?.({ downloadedBytes: 10, totalBytes: 10, layersCompleted: 1, layersTotal: 1 });
    },
    pullImageRef: async () => {
      calls.push('pull');
    },
    createVolume: async () => {
      calls.push('createVolume');
    },
    inspectVolume: async (name: string) => ({
      Name: name,
      Labels: {
        'com.wiolett.inference-core.owned': 'true',
        'com.wiolett.inference-core.project': 'gw',
      },
    }),
    createContainer: async (config: DockerCreateContainerConfig, name?: string) => {
      calls.push('createContainer');
      const id = `container-${++sequence}`;
      containers.set(id, {
        id,
        name: name ? `/${name}` : `/${id}`,
        image: config.Image,
        labels: config.Labels ?? {},
        running: false,
        config,
      });
      return id;
    },
    startContainer: async (id: string) => {
      calls.push('startContainer');
      containers.get(id)!.running = true;
    },
    stopContainer: async (id: string) => {
      calls.push('stopContainer');
      const c = containers.get(id);
      if (c) c.running = false;
    },
    restartContainer: async (id: string) => {
      calls.push('restartContainer');
      containers.get(id)!.running = true;
    },
    removeContainer: async (id: string) => {
      calls.push('removeContainer');
      containers.delete(id);
    },
    putContainerArchive: async () => {
      calls.push('putContainerArchive');
    },
    putContainerArchiveFromFile: async () => {
      calls.push('putContainerArchive');
    },
    getContainerArchive: async () => {
      calls.push('backupArchive');
      return Buffer.from('tar-bytes');
    },
    getContainerArchiveToFile: async (_id: string, _path: string, destination: string) => {
      calls.push('backupArchive');
      if (docker.failBackup) throw new Error('injected backup failure');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(destination, 'tar-bytes');
      return 9;
    },
    runOneShot: async (config: DockerCreateContainerConfig) => {
      if (config.Cmd?.join(' ').includes('find /state')) calls.push('clearStateVolume');
      return { exitCode: 0, output: '1024\n' };
    },
    removeImageTag: async (ref: string) => {
      calls.push(`removeImage:${ref}`);
      const index = images.findIndex(
        (image) => image.Id === ref || image.RepoTags?.includes(ref) || image.RepoDigests?.includes(ref)
      );
      if (index >= 0) images.splice(index, 1);
    },
    inspectContainer: async (id: string) => {
      const c = containers.get(id);
      if (!c) throw new Error('not found');
      return {
        State: { Status: c.running ? 'running' : 'exited', Running: c.running, StartedAt: '' },
        Config: { Image: c.image },
      };
    },
  };
  return docker;
}

function makeStore() {
  let row: InferenceCoreStateRow | null = null;
  return {
    get row() {
      return row;
    },
    setRow(value: InferenceCoreStateRow | null) {
      row = value;
    },
    loadState: async () => row,
    upsertState: async (patch: Partial<InferenceCoreStateRow>) => {
      const base =
        row ??
        ({
          id: 'default',
          state: 'not_installed',
          createdAt: new Date(),
          updatedAt: new Date(),
        } as InferenceCoreStateRow);
      row = { ...base, ...patch, updatedAt: new Date() };
    },
    loadLatestInfo: async () => null,
    storeLatestInfo: async () => {},
  };
}

function makeOperations() {
  const ops: Array<InferenceCoreOperation & { id: string }> = [];
  let sequence = 0;
  return {
    ops,
    begin: async (kind: string, fields: Record<string, unknown>) => {
      const op = {
        id: `op-${++sequence}`,
        kind,
        status: 'running',
        progress: null,
        error: null,
        startedAt: new Date(),
        heartbeatAt: new Date(),
        finishedAt: null,
        ...fields,
      } as unknown as InferenceCoreOperation & { id: string };
      ops.push(op);
      return op;
    },
    current: async () => ops.find((o) => o.status === 'running') ?? null,
    updatePhase: async (id: string, phase: string, progress?: unknown) => {
      const op = ops.find((o) => o.id === id);
      if (op) {
        (op as Record<string, unknown>).phase = phase;
        if (progress !== undefined) (op as Record<string, unknown>).progress = progress;
      }
    },
    heartbeat: async () => {},
    succeed: async (id: string) => {
      const op = ops.find((o) => o.id === id);
      if (op) op.status = 'succeeded';
    },
    fail: async (id: string, error: string) => {
      const op = ops.find((o) => o.id === id);
      if (op) {
        op.status = 'failed';
        op.error = error;
      }
    },
    failInterrupted: async () => 0,
    listRecent: async () => ops,
  };
}

const credentials: InferenceCoreCredentials = {
  dataCredential: `ocx_${'a'.repeat(40)}`,
  managementCredential: `ocx_${'b'.repeat(40)}`,
  callbackCredential: `ocx_${'c'.repeat(40)}`,
};

const vault = {
  seal: (payload: object) => ({
    encryptedPayload: Buffer.from(JSON.stringify(payload)).toString('base64'),
    encryptedDek: 'dek',
    keyVersion: 1,
  }),
  open: <T extends object>(sealed: { encryptedPayload: string }): T =>
    JSON.parse(Buffer.from(sealed.encryptedPayload, 'base64').toString('utf8')) as T,
};

/** The fake core answers readiness with the version of the running container. */
function stubCoreFetch(docker: ReturnType<typeof makeDocker>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const running = [...docker.containers.values()].find((c) => c.running);
      const version = running?.labels['com.wiolett.inference-core.version'] ?? OLD_VERSION;
      if (url.endsWith('/readyz')) {
        return Response.json({
          status: 'ready',
          service: 'opencodex',
          version: `v${version}`,
          contractId: 'wiolett-core/v1',
          coreProtocolMajor: 1,
          stateSchemaVersion: 1,
          instanceId: 'ocx-inst-test',
          startedAt: new Date().toISOString(),
        });
      }
      if (url.endsWith('/api/wiolett/status')) return Response.json({ draining: true });
      if (url.endsWith('/api/wiolett/drain') || url.endsWith('/api/wiolett/resume')) {
        return Response.json({ success: true });
      }
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    })
  );
}

function installedRow(dockerRow: Partial<InferenceCoreStateRow> = {}): InferenceCoreStateRow {
  return {
    id: 'default',
    state: 'ready',
    installedVersion: OLD_VERSION,
    installedDigest: OLD_DIGEST,
    installedImageRef: `${IMAGE}@${OLD_DIGEST}`,
    containerId: null,
    containerName: 'gw-inference-core',
    stateVolumeName: 'gw-inference-core-state',
    secretVolumeName: 'gw-inference-core-secrets',
    networkName: 'gw_default',
    coreProtocolMajor: 1,
    coreStateSchemaVersion: 1,
    healthStatus: 'healthy',
    credentialsPayload: vault.seal(credentials).encryptedPayload,
    credentialsDek: 'dek',
    credentialKeyVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...dockerRow,
  } as InferenceCoreStateRow;
}

const TIMINGS = { readyTimeoutMs: 500, readyPollMs: 1, drainTimeoutMs: 50, drainPollMs: 1, stabilityWindowMs: 1 };

let backupDir = '';

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let docker: ReturnType<typeof makeDocker>;
let store: ReturnType<typeof makeStore>;
let operations: ReturnType<typeof makeOperations>;
let eventBus: { publish: ReturnType<typeof vi.fn> };
let service: InferenceCoreRuntimeService;

beforeEach(() => {
  backupDir = mkdtempSync(join(tmpdir(), 'core-backups-'));
  docker = makeDocker();
  store = makeStore();
  operations = makeOperations();
  eventBus = { publish: vi.fn() };
  stubCoreFetch(docker);
  service = new InferenceCoreRuntimeService(
    store as never,
    docker as never,
    {
      APP_VERSION: '2.8.0',
      RELEASES_API_URL: 'https://updates.thesqlabs.com/gateway/releases',
      ARTIFACT_BASE_URL: 'https://updates.thesqlabs.com/gateway',
      INFERENCE_CORE_UPDATE_IMAGE_REPOSITORIES: 'ghcr.io/the-square-labs/inference-core',
    } as never,
    vault as never,
    operations as never,
    eventBus as never,
    { timings: TIMINGS, backupDir }
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await service.stop();
  rmSync(backupDir, { recursive: true, force: true });
});

describe('install', () => {
  it('installs a hardened container and reaches ready', async () => {
    await service.install();
    await waitFor(() => operations.ops[0]?.status === 'succeeded');

    expect(store.row?.state).toBe('ready');
    expect(store.row?.installedVersion).toBe(NEW_VERSION);
    expect(store.row?.installedDigest).toBe(NEW_DIGEST);
    expect(store.row?.coreProtocolMajor).toBe(1);

    const container = [...docker.containers.values()].find((c) => c.name === '/gw-inference-core');
    expect(container).toBeDefined();
    expect(container!.config.Image).toBe(`${IMAGE}@${NEW_DIGEST}`);
    expect(container!.config.User).toBe('10001:10001');
    expect(container!.config.Env).toContain('CODEX_HOME=/var/lib/opencodex');
    expect(container!.config.HostConfig?.ReadonlyRootfs).toBe(true);
    expect(container!.config.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(container!.config.HostConfig?.SecurityOpt).toEqual(['no-new-privileges']);
    expect(container!.config.HostConfig?.RestartPolicy?.Name).toBe('unless-stopped');
    // No published ports: no PortBindings, no host network.
    expect(container!.config.HostConfig && !('PortBindings' in container!.config.HostConfig)).toBe(true);
    expect(container!.config.HostConfig?.NetworkMode).toBeUndefined();
    // Only the two owned volumes, secrets mounted read-only.
    expect(container!.config.HostConfig?.Binds).toEqual([
      'gw-inference-core-state:/var/lib/opencodex',
      'gw-inference-core-secrets:/run/wiolett-secrets:ro',
    ]);
    expect(container!.labels['com.wiolett.inference-core.owned']).toBe('true');
    expect(container!.labels['com.wiolett.inference-core.digest']).toBe(NEW_DIGEST);
    // Credentials went to the secret volume, never to docker env.
    expect(docker.calls).toContain('putContainerArchive');
    expect((container!.config.Env ?? []).join(' ')).not.toContain('ocx_');
    expect(eventBus.publish).toHaveBeenCalledWith(
      'inference.core.changed',
      expect.objectContaining({ state: 'ready' })
    );
    expect(operations.ops[0]?.progress).toEqual({ stage: 'Checking readiness' });
  });

  it('fails immediately when the core reports terminal failed readiness', async () => {
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/readyz')) throw new Error(`unexpected fetch: ${url}`);
      return Response.json(
        {
          status: 'failed',
          service: 'opencodex',
          version: NEW_VERSION,
          contractId: 'wiolett-core/v1',
          coreProtocolMajor: 1,
          stateSchemaVersion: 1,
          instanceId: 'ocx-inst-test',
          startedAt: new Date().toISOString(),
        },
        { status: 503 }
      );
    });

    await service.install();
    await waitFor(() => operations.ops[0]?.status === 'failed');

    expect(store.row?.state).toBe('failed');
    expect(store.row?.lastError).toBe('core reported failed readiness');
    expect(operations.ops[0]?.error).toBe('core reported failed readiness');
  });

  it('fails without any Docker mutation when the manifest is untrusted', async () => {
    const manifestModule = await import('./inference-core.manifest.js');
    vi.mocked(manifestModule.fetchOpenCodexImageManifest).mockRejectedValueOnce(new Error('untrusted'));
    await service.install();
    await waitFor(() => operations.ops[0]?.status === 'failed');
    expect(store.row?.state).toBe('failed');
    expect(docker.calls).not.toContain('pull');
    expect(docker.calls).not.toContain('createContainer');
  });

  it('refuses to replace a foreign container occupying the core name', async () => {
    docker.containers.set('foreign-1', {
      id: 'foreign-1',
      name: '/gw-inference-core',
      image: 'unrelated:latest',
      labels: {},
      running: true,
      config: { Image: 'unrelated:latest' },
    });
    await service.install();
    await waitFor(() => operations.ops[0]?.status === 'failed');
    expect(docker.containers.has('foreign-1')).toBe(true);
    expect(store.row?.state).toBe('failed');
  });
});

describe('update', () => {
  beforeEach(() => {
    store.setRow(installedRow());
    // The running old core.
    docker.containers.set('core-old', {
      id: 'core-old',
      name: '/gw-inference-core',
      image: `${IMAGE}@${OLD_DIGEST}`,
      labels: {
        'com.wiolett.inference-core.owned': 'true',
        'com.wiolett.inference-core.project': 'gw',
        'com.wiolett.inference-core.digest': OLD_DIGEST,
        'com.wiolett.inference-core.version': OLD_VERSION,
      },
      running: true,
      config: { Image: `${IMAGE}@${OLD_DIGEST}` },
    });
    store.setRow(installedRow({ containerId: 'core-old' }));
  });

  it('pulls first, drains, backs up, replaces, and accepts the new version', async () => {
    docker.images.push(
      { Id: NEW_DIGEST, RepoDigests: [`${IMAGE}@${NEW_DIGEST}`] },
      { Id: `sha256:${'33'.repeat(32)}`, RepoDigests: [`${IMAGE}@sha256:${'33'.repeat(32)}`] }
    );
    await service.update(NEW_VERSION);
    await waitFor(() => operations.ops[0]?.status === 'succeeded');

    expect(store.row?.state).toBe('ready');
    expect(store.row?.installedVersion).toBe(NEW_VERSION);
    // Pull strictly before the old container stops (old core serves during download).
    const pullAt = docker.calls.indexOf('pull');
    const stopAt = docker.calls.indexOf('stopContainer');
    expect(pullAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(pullAt);
    // The state backup is streamed out before the old container is replaced.
    const backupAt = docker.calls.indexOf('backupArchive');
    expect(backupAt).toBeGreaterThan(pullAt);
    expect(stopAt).toBeGreaterThan(backupAt);
    // Old image pruned only after acceptance.
    expect(docker.calls).toContain(`removeImage:${IMAGE}@${OLD_DIGEST}`);
    expect(docker.calls).toContain(`removeImage:sha256:${'33'.repeat(32)}`);
    expect(docker.calls).not.toContain(`removeImage:${NEW_DIGEST}`);
    // The old container is gone; exactly one core container runs.
    const cores = [...docker.containers.values()].filter((c) => c.name === '/gw-inference-core');
    expect(cores).toHaveLength(1);
    expect(cores[0].labels['com.wiolett.inference-core.digest']).toBe(NEW_DIGEST);
  });

  it('resumes the old core when streaming backup fails before replacement', async () => {
    docker.failBackup = true;

    await service.update(NEW_VERSION);
    await waitFor(() => operations.ops[0]?.status === 'failed');

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/wiolett/resume'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(docker.containers.get('core-old')?.running).toBe(true);
    expect(docker.calls).not.toContain('stopContainer');
    expect(store.row?.state).toBe('degraded');
  });

  it('rolls back to the previous digest and state when the new core never becomes ready', async () => {
    // The fake readiness probe reports the RUNNING container's version; force the
    // new container to report the old version (identity mismatch = never ready).
    const originalFetch = vi.mocked(fetch);
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/readyz')) {
        return Response.json({
          status: 'ready',
          service: 'opencodex',
          version: OLD_VERSION, // wrong identity for the new container
          contractId: 'wiolett-core/v1',
          coreProtocolMajor: 1,
          stateSchemaVersion: 1,
          instanceId: 'ocx-inst-test',
          startedAt: new Date().toISOString(),
        });
      }
      return originalFetch(input as never);
    });

    await service.update(NEW_VERSION);
    await waitFor(() => operations.ops[0]?.status === 'failed', 15_000);

    expect(store.row?.state).toBe('ready');
    expect(store.row?.installedVersion).toBe(OLD_VERSION);
    expect(store.row?.installedDigest).toBe(OLD_DIGEST);
    expect(store.row?.lastError).toContain('rolled back');
    const cores = [...docker.containers.values()].filter((c) => c.name === '/gw-inference-core');
    expect(cores).toHaveLength(1);
    expect(cores[0].labels['com.wiolett.inference-core.digest']).toBe(OLD_DIGEST);
    expect(docker.calls.indexOf('clearStateVolume')).toBeLessThan(docker.calls.lastIndexOf('putContainerArchive'));
  });
});

describe('reconcileOnStartup', () => {
  it('marks the core failed when a foreign container occupies the name', async () => {
    store.setRow(installedRow({ containerId: 'gone' }));
    docker.containers.set('foreign-1', {
      id: 'foreign-1',
      name: '/gw-inference-core',
      image: 'unrelated:latest',
      labels: {},
      running: true,
      config: { Image: 'unrelated:latest' },
    });
    await service.reconcileOnStartup();
    expect(store.row?.state).toBe('failed');
    expect(store.row?.lastError).toContain('foreign container');
    expect(docker.containers.has('foreign-1')).toBe(true);
  });

  it('marks the core degraded when the container is missing', async () => {
    store.setRow(installedRow({ containerId: 'gone' }));
    await service.reconcileOnStartup();
    expect(store.row?.state).toBe('degraded');
  });

  it('removes owned duplicate containers and keeps the recorded one', async () => {
    store.setRow(installedRow({ containerId: 'core-a' }));
    for (const id of ['core-a', 'core-b']) {
      docker.containers.set(id, {
        id,
        name: '/gw-inference-core',
        image: `${IMAGE}@${OLD_DIGEST}`,
        labels: {
          'com.wiolett.inference-core.owned': 'true',
          'com.wiolett.inference-core.project': 'gw',
          'com.wiolett.inference-core.digest': OLD_DIGEST,
          'com.wiolett.inference-core.version': OLD_VERSION,
        },
        running: true,
        config: { Image: `${IMAGE}@${OLD_DIGEST}` },
      });
    }
    await service.reconcileOnStartup();
    expect(docker.containers.has('core-a')).toBe(true);
    expect(docker.containers.has('core-b')).toBe(false);
  });

  it('removes abandoned labeled helper containers during startup reconciliation', async () => {
    store.setRow(installedRow({ containerId: 'core-a' }));
    docker.containers.set('core-a', {
      id: 'core-a',
      name: '/gw-inference-core',
      image: `${IMAGE}@${OLD_DIGEST}`,
      labels: {
        'com.wiolett.inference-core.owned': 'true',
        'com.wiolett.inference-core.project': 'gw',
        'com.wiolett.inference-core.digest': OLD_DIGEST,
      },
      running: true,
      config: { Image: `${IMAGE}@${OLD_DIGEST}` },
    });
    docker.containers.set('helper-a', {
      id: 'helper-a',
      name: '/abandoned-helper',
      image: `${IMAGE}@${OLD_DIGEST}`,
      labels: {
        'com.wiolett.inference-core.owned': 'true',
        'com.wiolett.inference-core.project': 'gw',
        'com.wiolett.inference-core.role': 'helper',
      },
      running: false,
      config: { Image: `${IMAGE}@${OLD_DIGEST}` },
    });

    await service.reconcileOnStartup();

    expect(docker.containers.has('core-a')).toBe(true);
    expect(docker.containers.has('helper-a')).toBe(false);
  });

  it('resumes the unchanged core and restores ready state after an interrupted update', async () => {
    store.setRow(installedRow({ state: 'updating', containerId: 'core-a' }));
    docker.containers.set('core-a', {
      id: 'core-a',
      name: '/gw-inference-core',
      image: `${IMAGE}@${OLD_DIGEST}`,
      labels: {
        'com.wiolett.inference-core.owned': 'true',
        'com.wiolett.inference-core.project': 'gw',
        'com.wiolett.inference-core.digest': OLD_DIGEST,
        'com.wiolett.inference-core.version': OLD_VERSION,
      },
      running: true,
      config: { Image: `${IMAGE}@${OLD_DIGEST}` },
    });

    await service.reconcileOnStartup();

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/wiolett/resume'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(store.row?.state).toBe('ready');
    expect(store.row?.healthStatus).toBe('healthy');
  });

  it('marks interrupted operations as failed', async () => {
    const op = await operations.begin('install', { phase: 'pulling' });
    expect(op.status).toBe('running');
    let calls = 0;
    const original = operations.failInterrupted;
    operations.failInterrupted = async () => {
      calls += 1;
      return original();
    };
    await service.reconcileOnStartup();
    expect(calls).toBe(1);
  });
});

describe('repair', () => {
  it('recreates a missing container at the recorded digest', async () => {
    store.setRow(installedRow({ state: 'degraded', containerId: 'gone' }));
    await service.repair();
    await waitFor(() => operations.ops[0]?.status === 'succeeded');
    expect(store.row?.state).toBe('ready');
    const cores = [...docker.containers.values()].filter((c) => c.name === '/gw-inference-core');
    expect(cores).toHaveLength(1);
    expect(cores[0].image).toBe(`${IMAGE}@${OLD_DIGEST}`);
  });

  it('refuses repair on a healthy core', async () => {
    store.setRow(installedRow({ state: 'ready' }));
    await expect(service.repair()).rejects.toMatchObject({ code: 'CORE_NOT_REPAIRABLE' });
  });
});

describe('buildSingleFileTar', () => {
  it('builds a valid ustar entry with restrictive ownership', () => {
    const content = Buffer.from('{"secret":true}', 'utf8');
    const tar = buildSingleFileTar('credentials.json', content, 0o600, 10001, 10001);
    expect(tar.length).toBe(512 + 512 + 1024);
    expect(tar.subarray(0, 100).toString('utf8').replace(/\0+$/s, '')).toBe('credentials.json');
    expect(tar.subarray(257, 262).toString('ascii')).toBe('ustar');
    // mode 0600, uid/gid 10001
    expect(tar.subarray(100, 107).toString('ascii')).toBe('0000600');
    expect(tar.subarray(108, 115).toString('ascii')).toBe('0023421');
    // ustar checksum field validates against the header bytes
    const stored = parseInt(tar.subarray(148, 154).toString('ascii'), 8);
    const header = Buffer.from(tar.subarray(0, 512));
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    expect(stored).toBe(sum);
    expect(tar.subarray(512, 512 + content.length).equals(content)).toBe(true);
  });
});
