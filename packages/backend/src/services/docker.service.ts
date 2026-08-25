import http from 'node:http';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('DockerService');

const API_VERSION = '/v1.46';

export class DockerService {
  constructor(
    private readonly socketPath: string,
    private readonly nginxContainerName: string
  ) {}

  /**
   * Execute a command inside a Docker container via the Docker Engine API.
   *
   * 1. POST /containers/{id}/exec  -> create exec instance
   * 2. POST /exec/{id}/start       -> run and capture output
   * 3. GET  /exec/{id}/inspect      -> retrieve exit code
   */
  async execInContainer(containerName: string, command: string[]): Promise<{ exitCode: number; output: string }> {
    logger.debug('Creating exec instance', { containerName, command });

    // Step 1: Create exec instance
    const createRes = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(containerName)}/exec`,
      {
        Cmd: command,
        AttachStdout: true,
        AttachStderr: true,
      }
    );

    if (createRes.statusCode !== 201) {
      throw new Error(`Docker exec create failed (${createRes.statusCode}): ${createRes.body}`);
    }

    const { Id: execId } = JSON.parse(createRes.body) as { Id: string };

    // Step 2: Start exec and capture output
    const startRes = await this.request('POST', `${API_VERSION}/exec/${execId}/start`, {
      Detach: false,
    });

    if (startRes.statusCode !== 200) {
      throw new Error(`Docker exec start failed (${startRes.statusCode}): ${startRes.body}`);
    }

    // The output stream from Docker may contain multiplexed header frames
    // (8-byte header per frame when AttachStdout + AttachStderr).
    // We strip those headers to get clean text output.
    const output = this.stripDockerStreamHeaders(startRes.bodyRaw);

    // Step 3: Inspect exec to get exit code
    const inspectRes = await this.request('GET', `${API_VERSION}/exec/${execId}/json`);

    if (inspectRes.statusCode !== 200) {
      throw new Error(`Docker exec inspect failed (${inspectRes.statusCode}): ${inspectRes.body}`);
    }

    const { ExitCode } = JSON.parse(inspectRes.body) as { ExitCode: number };

    logger.debug('Exec completed', { containerName, command, exitCode: ExitCode });

    return { exitCode: ExitCode, output };
  }

  async runManagedRegistryGarbageCollection(dryRun: boolean): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const inspected = await this.request('GET', `${API_VERSION}/containers/${registryId}/json`);
    if (inspected.statusCode !== 200) throw new Error(`Registry inspect failed (${inspected.statusCode})`);
    const registry = JSON.parse(inspected.body) as {
      Config?: { Image?: string; Env?: string[]; Entrypoint?: string[] | string | null };
      HostConfig?: { Binds?: string[] };
    };
    const image = registry.Config?.Image;
    if (!image) throw new Error('Managed registry image is unavailable');
    const temporaryName = `gateway-registry-gc-${process.pid}-${Date.now()}`;
    let temporaryId: string | null = null;
    let registryStopped = false;
    let operationError: unknown;
    let restartError: Error | null = null;
    try {
      const stopped = await this.request('POST', `${API_VERSION}/containers/${registryId}/stop?t=30`);
      if (stopped.statusCode !== 204 && stopped.statusCode !== 304) {
        throw new Error(`Registry stop failed (${stopped.statusCode}): ${stopped.body}`);
      }
      registryStopped = true;
      const args = [
        'garbage-collect',
        ...(dryRun ? ['--dry-run'] : []),
        '--delete-untagged',
        '/etc/distribution/config.yml',
      ];
      const created = await this.request(
        'POST',
        `${API_VERSION}/containers/create?name=${encodeURIComponent(temporaryName)}`,
        {
          Image: image,
          Env: registry.Config?.Env ?? [],
          Entrypoint: registry.Config?.Entrypoint ?? undefined,
          Cmd: args,
          HostConfig: { Binds: registry.HostConfig?.Binds ?? [], NetworkMode: 'none' },
        }
      );
      if (created.statusCode !== 201) {
        throw new Error(`Registry GC container create failed (${created.statusCode}): ${created.body}`);
      }
      temporaryId = (JSON.parse(created.body) as { Id: string }).Id;
      const started = await this.request('POST', `${API_VERSION}/containers/${temporaryId}/start`);
      if (started.statusCode !== 204) throw new Error(`Registry GC container start failed (${started.statusCode})`);
      const waited = await this.request(
        'POST',
        `${API_VERSION}/containers/${temporaryId}/wait?condition=not-running`,
        undefined,
        30 * 60_000
      );
      if (waited.statusCode !== 200) throw new Error(`Registry GC wait failed (${waited.statusCode})`);
      const statusCode = Number((JSON.parse(waited.body) as { StatusCode?: number }).StatusCode ?? 1);
      if (statusCode !== 0) {
        const logs = await this.request(
          'GET',
          `${API_VERSION}/containers/${temporaryId}/logs?stdout=1&stderr=1&tail=100`
        );
        throw new Error(
          `Registry garbage collection failed (${statusCode}): ${this.stripDockerStreamHeaders(logs.bodyRaw)}`
        );
      }
    } catch (error) {
      operationError = error;
    } finally {
      if (temporaryId) {
        await this.request('DELETE', `${API_VERSION}/containers/${temporaryId}?force=1`).catch(() => undefined);
      }
      if (registryStopped) {
        const started = await this.request('POST', `${API_VERSION}/containers/${registryId}/start`).catch(() => null);
        if (!started || (started.statusCode !== 204 && started.statusCode !== 304)) {
          restartError = new Error('Managed registry could not be restarted after garbage collection');
        }
      }
    }
    if (restartError) throw restartError;
    if (operationError) throw operationError;
  }

  async stopManagedRegistry(): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const stopped = await this.request('POST', `${API_VERSION}/containers/${registryId}/stop?t=30`);
    if (stopped.statusCode !== 204 && stopped.statusCode !== 304) {
      throw new Error(`Registry stop failed (${stopped.statusCode}): ${stopped.body}`);
    }
  }

  async startManagedRegistry(): Promise<void> {
    const registryId = await this.managedRegistryContainerId();
    const started = await this.request('POST', `${API_VERSION}/containers/${registryId}/start`);
    if (started.statusCode !== 204 && started.statusCode !== 304) {
      throw new Error(`Registry start failed (${started.statusCode}): ${started.body}`);
    }
  }

  async restartManagedRegistry(): Promise<void> {
    await this.stopManagedRegistry();
    await this.startManagedRegistry();
  }

  async recoverManagedRegistryMaintenance(): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ name: ['gateway-registry-gc-'] }));
    const listed = await this.request('GET', `${API_VERSION}/containers/json?all=1&filters=${filters}`);
    if (listed.statusCode !== 200) throw new Error(`Docker GC container lookup failed (${listed.statusCode})`);
    const containers = JSON.parse(listed.body) as Array<{ Id?: string }>;
    for (const container of containers) {
      if (!container.Id) continue;
      await this.request('DELETE', `${API_VERSION}/containers/${container.Id}?force=1`).catch(() => undefined);
    }
    await this.startManagedRegistry();
  }

  private async managedRegistryContainerId(): Promise<string> {
    const filters = encodeURIComponent(JSON.stringify({ label: ['com.wiolett.gateway.managed-service=registry'] }));
    const listed = await this.request('GET', `${API_VERSION}/containers/json?all=1&filters=${filters}`);
    if (listed.statusCode !== 200) throw new Error(`Docker container lookup failed (${listed.statusCode})`);
    const containers = JSON.parse(listed.body) as Array<{ Id?: string }>;
    const registryId = containers[0]?.Id;
    if (!registryId) throw new Error('Managed registry container was not found');
    return registryId;
  }

  /**
   * Low-level helper that sends an HTTP request over the Docker unix socket.
   */
  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    headers: Record<string, string> = {}
  ): Promise<{ statusCode: number; body: string; bodyRaw: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf-8');

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: timeoutMs,
          headers: {
            ...headers,
            ...(payload !== undefined
              ? {
                  ...(!headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}),
                  'Content-Length': payload.byteLength,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const rawBuffer = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode ?? 0,
              body: rawBuffer.toString('utf-8'),
              bodyRaw: rawBuffer,
            });
          });
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Docker API request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (payload !== undefined) req.write(payload);

      req.end();
    });
  }

  /**
   * Streaming variant of {@link request}: response chunks are forwarded to
   * `onChunk` as they arrive instead of being buffered whole. Used for the
   * NDJSON progress stream of image pulls, where buffering would hide all
   * progress until the pull finished.
   */
  private requestStream(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number | undefined,
    onChunk: (chunk: string) => void
  ): Promise<{ statusCode: number }> {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf-8');

      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          timeout: timeoutMs,
          headers:
            payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {},
        },
        (res) => {
          res.on('data', (chunk: Buffer) => onChunk(chunk.toString('utf-8')));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0 }));
          res.on('error', reject);
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`Docker API request timed out after ${timeoutMs}ms`));
      });
      req.on('error', reject);

      if (payload !== undefined) req.write(payload);

      req.end();
    });
  }

  /**
   * Docker multiplexed stream format:
   *   [stream_type(1 byte)][0][0][0][size(4 bytes big-endian)][payload(size bytes)]
   *
   * stream_type: 0 = stdin, 1 = stdout, 2 = stderr
   *
   * If the buffer does not look like a multiplexed stream we return it as-is.
   */
  private stripDockerStreamHeaders(raw: Buffer): string {
    // Quick check: a multiplexed frame starts with 0x00, 0x01, or 0x02
    // followed by three zero bytes. If the buffer is too small or doesn't
    // match, just return the raw text.
    if (raw.length < 8) {
      return raw.toString('utf-8');
    }

    const firstByte = raw[0];
    if (firstByte !== 0 && firstByte !== 1 && firstByte !== 2) {
      return raw.toString('utf-8');
    }
    if (raw[1] !== 0 || raw[2] !== 0 || raw[3] !== 0) {
      return raw.toString('utf-8');
    }

    // Parse multiplexed frames
    const parts: string[] = [];
    let offset = 0;
    while (offset + 8 <= raw.length) {
      const frameSize = raw.readUInt32BE(offset + 4);
      const frameEnd = offset + 8 + frameSize;
      if (frameEnd > raw.length) {
        // Incomplete frame — append remainder as-is
        parts.push(raw.subarray(offset + 8).toString('utf-8'));
        break;
      }
      parts.push(raw.subarray(offset + 8, frameEnd).toString('utf-8'));
      offset = frameEnd;
    }
    return parts.join('');
  }

  /**
   * Fetch one-shot container stats from the Docker Engine API.
   */
  async getContainerStats(containerName: string): Promise<DockerContainerStats> {
    const res = await this.request(
      'GET',
      `${API_VERSION}/containers/${encodeURIComponent(containerName)}/stats?stream=false`
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker stats failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerStats;
  }

  /**
   * Inspect a container to get state, uptime, etc.
   */
  async inspectContainer(containerName: string): Promise<DockerContainerInspect> {
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(containerName)}/json`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerInspect;
  }

  /**
   * Test the Nginx configuration inside the nginx container.
   */
  async testNginxConfig(): Promise<{ valid: boolean; error?: string }> {
    logger.info('Testing Nginx configuration');
    const result = await this.execInContainer(this.nginxContainerName, ['nginx', '-t']);
    const valid = result.exitCode === 0;
    if (!valid) {
      logger.warn('Nginx config test failed', { output: result.output });
    }
    return {
      valid,
      error: valid ? undefined : result.output,
    };
  }

  /**
   * Reload the Nginx process inside the nginx container.
   */
  async reloadNginx(): Promise<void> {
    logger.info('Reloading Nginx');
    const result = await this.execInContainer(this.nginxContainerName, ['nginx', '-s', 'reload']);
    if (result.exitCode !== 0) {
      throw new Error(`Nginx reload failed: ${result.output}`);
    }
    logger.info('Nginx reloaded successfully');
  }

  /**
   * Pull a Docker image from a registry.
   * The Docker API streams progress — we read until the stream ends.
   */
  async pullImage(image: string, tag: string): Promise<void> {
    logger.info('Pulling Docker image', { image, tag });
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
      undefined,
      300_000 // 5 min timeout for image pulls
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode}): ${res.body}`);
    }
    // Check last line of streaming output for errors
    const lines = res.body.trim().split('\n');
    const last = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last) as { error?: string };
      if (parsed.error) {
        throw new Error(`Docker image pull error: ${parsed.error}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Docker image pull error')) throw e;
      // Not JSON — ignore parse error
    }
    logger.info('Image pulled successfully', { image, tag });
  }

  /**
   * Pull a Docker image by immutable reference, e.g. registry/app@sha256:...
   */
  async pullImageRef(imageRef: string): Promise<void> {
    logger.info('Pulling Docker image by reference', { imageRef });
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(imageRef)}`,
      undefined,
      300_000
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode}): ${res.body}`);
    }
    const lines = res.body.trim().split('\n');
    const last = lines[lines.length - 1];
    try {
      const parsed = JSON.parse(last) as { error?: string };
      if (parsed.error) {
        throw new Error(`Docker image pull error: ${parsed.error}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Docker image pull error')) throw e;
    }
    logger.info('Image reference pulled successfully', { imageRef });
  }

  /**
   * Pull an image by immutable reference while streaming the daemon's NDJSON
   * progress. Reports only what Docker actually supplies: byte totals appear
   * solely when every seen layer has a known size, layer counts count distinct
   * layer ids, and a layer counts as completed on "Pull complete"/"Already
   * exists". Long pulls get a matching request timeout.
   */
  async pullImageRefStreaming(imageRef: string, onProgress?: (progress: DockerPullProgress) => void): Promise<void> {
    logger.info('Pulling Docker image by reference (streaming)', { imageRef });
    const layers = new Map<string, { current: number; total: number; done: boolean; cached: boolean }>();
    let ndjsonError: string | null = null;
    let buffer = '';

    const emit = () => {
      if (!onProgress) return;
      const all = [...layers.values()];
      const layersTotal = all.length;
      const layersCompleted = all.filter((layer) => layer.done).length;
      const downloadable = all.filter((layer) => !layer.cached);
      const downloadedBytes = downloadable.reduce((sum, layer) => sum + layer.current, 0);
      const everySizeKnown = downloadable.length > 0 && downloadable.every((layer) => layer.total > 0);
      const progress: DockerPullProgress = { layersCompleted, layersTotal };
      if (everySizeKnown) {
        progress.downloadedBytes = downloadedBytes;
        progress.totalBytes = downloadable.reduce((sum, layer) => sum + layer.total, 0);
      }
      onProgress(progress);
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: {
        id?: string;
        status?: string;
        progressDetail?: { current?: number; total?: number };
        error?: string;
        message?: string;
      };
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof event.error === 'string' && event.error) {
        ndjsonError = event.error;
        return;
      }
      // Docker returns one JSON object with `message` (rather than an NDJSON
      // `error`) for request-level failures such as a missing platform in a
      // manifest list. Preserve that actionable daemon explanation.
      if (typeof event.message === 'string' && event.message && !event.id && !event.status) {
        ndjsonError = event.message;
        return;
      }
      if (!event.id || !event.status) return;
      const layer = layers.get(event.id) ?? { current: 0, total: 0, done: false, cached: false };
      if (
        event.status === 'Already exists' ||
        event.status === 'Pull complete' ||
        event.status === 'Download complete'
      ) {
        layer.done = true;
        if (event.status === 'Already exists') layer.cached = true;
        if (event.progressDetail?.total !== undefined) layer.total = event.progressDetail.total;
        // A completed layer is fully downloaded even when the completion
        // event itself carries no progress detail.
        if (layer.total > 0) layer.current = layer.total;
        else if (event.progressDetail?.current !== undefined) layer.current = event.progressDetail.current;
      } else {
        if (event.progressDetail?.current !== undefined) layer.current = event.progressDetail.current;
        if (event.progressDetail?.total !== undefined) layer.total = event.progressDetail.total;
      }
      layers.set(event.id, layer);
      emit();
    };

    const res = await this.requestStream(
      'POST',
      `${API_VERSION}/images/create?fromImage=${encodeURIComponent(imageRef)}`,
      undefined,
      30 * 60_000,
      (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          handleLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      }
    );
    if (buffer.trim()) handleLine(buffer);
    if (ndjsonError) throw new Error(`Docker image pull error: ${ndjsonError}`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker image pull failed (${res.statusCode})`);
    }
    logger.info('Image reference pulled successfully', { imageRef });
  }

  /**
   * Create a named volume with ownership labels. Docker treats a create for an
   * existing name as idempotent and returns the volume, so this is safe to
   * retry after an interrupted operation.
   */
  async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/volumes/create`, { Name: name, Labels: labels });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`Docker volume create failed (${res.statusCode}): ${res.body}`);
    }
  }

  async inspectVolume(name: string): Promise<DockerVolumeInspect | null> {
    const res = await this.request('GET', `${API_VERSION}/volumes/${encodeURIComponent(name)}`);
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) {
      throw new Error(`Docker volume inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerVolumeInspect;
  }

  /** Remove a volume; missing volumes are treated as already removed. */
  async removeVolume(name: string): Promise<void> {
    const res = await this.request('DELETE', `${API_VERSION}/volumes/${encodeURIComponent(name)}?force=true`);
    if (res.statusCode === 204 || res.statusCode === 404) return;
    throw new Error(`Docker volume remove failed (${res.statusCode}): ${res.body}`);
  }

  async imageExists(imageRef: string): Promise<boolean> {
    const res = await this.request('GET', `${API_VERSION}/images/${encodeURIComponent(imageRef)}/json`);
    if (res.statusCode === 200) return true;
    if (res.statusCode === 404) return false;
    throw new Error(`Docker image inspect failed (${res.statusCode}): ${res.body}`);
  }

  async tagImage(sourceRef: string, targetRepo: string, targetTag: string): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/images/${encodeURIComponent(sourceRef)}/tag?repo=${encodeURIComponent(targetRepo)}&tag=${encodeURIComponent(targetTag)}`
    );
    if (res.statusCode !== 201) {
      throw new Error(`Docker image tag failed (${res.statusCode}): ${res.body}`);
    }
  }

  async removeImageTag(imageRef: string): Promise<void> {
    const res = await this.request(
      'DELETE',
      `${API_VERSION}/images/${encodeURIComponent(imageRef)}?force=false&noprune=true`
    );
    if (res.statusCode === 200 || res.statusCode === 202 || res.statusCode === 404) return;
    throw new Error(`Docker image tag remove failed (${res.statusCode}): ${res.body}`);
  }

  /**
   * Inspect the container this app is running in.
   * Uses HOSTNAME env var which Docker sets to the short container ID.
   */
  async inspectSelf(): Promise<DockerContainerFullInspect> {
    const hostname = process.env.HOSTNAME;
    if (!hostname) {
      throw new Error('HOSTNAME env var not available — cannot self-inspect');
    }
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(hostname)}/json`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker self-inspect failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerFullInspect;
  }

  /**
   * Create a container. Returns the container ID.
   */
  async createContainer(config: DockerCreateContainerConfig, name?: string): Promise<string> {
    const query = name ? `?name=${encodeURIComponent(name)}` : '';
    const res = await this.request('POST', `${API_VERSION}/containers/create${query}`, config);
    if (res.statusCode !== 201) {
      throw new Error(`Docker container create failed (${res.statusCode}): ${res.body}`);
    }
    const { Id } = JSON.parse(res.body) as { Id: string };
    return Id;
  }

  /**
   * Start a container by ID.
   */
  async startContainer(id: string): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/containers/${encodeURIComponent(id)}/start`);
    // 204 = started, 304 = already running
    if (res.statusCode !== 204 && res.statusCode !== 304) {
      throw new Error(`Docker container start failed (${res.statusCode}): ${res.body}`);
    }
  }

  async restartContainer(id: string, timeoutSeconds = 10): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/restart?t=${encodeURIComponent(String(timeoutSeconds))}`
    );
    if (res.statusCode !== 204) {
      throw new Error(`Docker container restart failed (${res.statusCode}): ${res.body}`);
    }
  }

  async connectContainerToNetwork(id: string, network: string, aliases: string[] = []): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/networks/${encodeURIComponent(network)}/connect`, {
      Container: id,
      EndpointConfig: aliases.length > 0 ? { Aliases: aliases } : {},
    });
    if (res.statusCode === 200) return;
    if (res.statusCode === 403 && /already exists|already connected/i.test(res.body)) return;
    throw new Error(`Docker network connect failed (${res.statusCode}): ${res.body}`);
  }

  /**
   * Wait for a container to exit. Returns the exit code.
   */
  async waitContainer(id: string, timeoutMs = 300_000): Promise<number> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/wait`,
      undefined,
      timeoutMs
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker container wait failed (${res.statusCode}): ${res.body}`);
    }
    const { StatusCode } = JSON.parse(res.body) as { StatusCode: number };
    return StatusCode;
  }

  /**
   * Remove a container by ID.
   */
  async removeContainer(id: string): Promise<void> {
    const res = await this.request('DELETE', `${API_VERSION}/containers/${encodeURIComponent(id)}?force=true`);
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new Error(`Docker container remove failed (${res.statusCode}): ${res.body}`);
    }
  }

  async stopContainer(id: string, timeoutSeconds = 5): Promise<void> {
    const res = await this.request(
      'POST',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/stop?t=${encodeURIComponent(String(timeoutSeconds))}`
    );
    if (res.statusCode !== 204 && res.statusCode !== 304 && res.statusCode !== 404) {
      throw new Error(`Docker container stop failed (${res.statusCode}): ${res.body}`);
    }
  }

  async killContainer(id: string): Promise<void> {
    const res = await this.request('POST', `${API_VERSION}/containers/${encodeURIComponent(id)}/kill`);
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new Error(`Docker container kill failed (${res.statusCode}): ${res.body}`);
    }
  }

  async getContainerLogs(
    id: string,
    options: { stdout?: boolean; stderr?: boolean; tail?: number } = {}
  ): Promise<string> {
    const params = new URLSearchParams({
      stdout: String(options.stdout ?? true),
      stderr: String(options.stderr ?? true),
    });
    if (options.tail !== undefined) params.set('tail', String(Math.max(0, Math.floor(options.tail))));
    const res = await this.request('GET', `${API_VERSION}/containers/${encodeURIComponent(id)}/logs?${params}`);
    if (res.statusCode !== 200 && res.statusCode !== 404) {
      throw new Error(`Docker container logs failed (${res.statusCode}): ${res.body}`);
    }
    return this.stripDockerStreamHeaders(res.bodyRaw);
  }

  async listContainersByLabel(label: string): Promise<DockerContainerListItem[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    const res = await this.request('GET', `${API_VERSION}/containers/json?all=true&filters=${filters}`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker container list failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerListItem[];
  }

  /** Local Docker inventory used by host-safety checks. */
  async listLocalContainers(): Promise<DockerContainerListItem[]> {
    const res = await this.request('GET', `${API_VERSION}/containers/json?all=true`);
    if (res.statusCode !== 200) {
      throw new Error(`Docker container list failed (${res.statusCode}): ${res.body}`);
    }
    return JSON.parse(res.body) as DockerContainerListItem[];
  }

  async putContainerArchive(id: string, containerPath: string, tarArchive: Buffer): Promise<void> {
    const params = new URLSearchParams({ path: containerPath });
    const res = await this.request(
      'PUT',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
      tarArchive,
      300_000,
      { 'Content-Type': 'application/x-tar' }
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker put archive failed (${res.statusCode}): ${res.body}`);
    }
  }

  /**
   * Read a path out of a (possibly stopped) container as a tar archive. Used
   * for state-volume backups: the helper container only mounts the volume and
   * is never started, so nothing executes inside it.
   */
  async getContainerArchive(id: string, containerPath: string): Promise<Buffer> {
    const params = new URLSearchParams({ path: containerPath });
    const res = await this.request(
      'GET',
      `${API_VERSION}/containers/${encodeURIComponent(id)}/archive?${params}`,
      undefined,
      300_000
    );
    if (res.statusCode !== 200) {
      throw new Error(`Docker get archive failed (${res.statusCode}): ${res.body}`);
    }
    return res.bodyRaw;
  }

  /**
   * Create, start, wait for completion, and clean up a one-shot container.
   */
  async runOneShot(config: DockerCreateContainerConfig): Promise<{ exitCode: number; output: string }> {
    const id = await this.createContainer(config);
    try {
      await this.startContainer(id);
      const exitCode = await this.waitContainer(id);
      // Capture logs
      const logRes = await this.request(
        'GET',
        `${API_VERSION}/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true`
      );
      const output = this.stripDockerStreamHeaders(logRes.bodyRaw);
      return { exitCode, output };
    } finally {
      await this.removeContainer(id).catch(() => {});
    }
  }

  /**
   * Create and start a detached container (fire-and-forget).
   */
  async runDetached(config: DockerCreateContainerConfig): Promise<string> {
    const id = await this.createContainer(config);
    await this.startContainer(id);
    logger.info('Started detached container', { id: id.slice(0, 12) });
    return id;
  }
}

export interface DockerContainerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
    online_cpus: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
    stats?: { cache?: number };
  };
  blkio_stats: {
    io_service_bytes_recursive: Array<{ op: string; value: number }> | null;
  };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

export interface DockerContainerInspect {
  State: {
    Status: string;
    Running: boolean;
    StartedAt: string;
  };
  Config: {
    Image: string;
  };
}

export interface DockerContainerFullInspect extends DockerContainerInspect {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
    Env: string[];
  };
  HostConfig?: {
    NetworkMode?: string;
  };
  NetworkSettings?: {
    Networks?: Record<string, { Aliases?: string[]; IPAddress?: string }>;
  };
}

export interface DockerVolumeInspect {
  Name: string;
  Driver?: string;
  Mountpoint?: string;
  Labels?: Record<string, string>;
}

export interface DockerPullProgress {
  downloadedBytes?: number;
  totalBytes?: number;
  layersCompleted?: number;
  layersTotal?: number;
}

export interface DockerCreateContainerConfig {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  Env?: string[];
  Labels?: Record<string, string>;
  User?: string;
  WorkingDir?: string;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  AttachStdin?: boolean;
  OpenStdin?: boolean;
  StdinOnce?: boolean;
  Tty?: boolean;
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[] }>;
  };
  HostConfig?: {
    Binds?: string[];
    AutoRemove?: boolean;
    ReadonlyRootfs?: boolean;
    NetworkMode?: string;
    CapDrop?: string[];
    SecurityOpt?: string[];
    PidsLimit?: number;
    Memory?: number;
    MemorySwap?: number;
    CpuPeriod?: number;
    CpuQuota?: number;
    CpuShares?: number;
    BlkioWeight?: number;
    Tmpfs?: Record<string, string>;
    LogConfig?: {
      Type: string;
      Config?: Record<string, string>;
    };
    RestartPolicy?: {
      Name: 'no' | 'always' | 'unless-stopped' | 'on-failure';
      MaximumRetryCount?: number;
    };
  };
}

export interface DockerContainerListItem {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string }>;
  };
}
