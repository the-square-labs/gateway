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
