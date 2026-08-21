import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DockerPullProgress, DockerService } from './docker.service.js';

let socketDir = '';
let server: http.Server | null = null;

function serveNdjson(lines: string[], chunksPerLine = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (!req.url?.startsWith('/v1.46/images/create')) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      let index = 0;
      const pump = () => {
        if (index >= lines.length) {
          res.end();
          resolve();
          return;
        }
        const line = `${lines[index]}\n`;
        index += 1;
        // Split each line into multiple chunks to exercise buffering.
        const cut = Math.max(1, Math.floor(line.length / chunksPerLine));
        for (let offset = 0; offset < line.length; offset += cut) {
          res.write(line.slice(offset, offset + cut));
        }
        setTimeout(pump, 5);
      };
      pump();
    });
    server.on('error', reject);
    server.listen(join(socketDir, 'docker.sock'));
  });
}

beforeEach(() => {
  socketDir = mkdtempSync(join(tmpdir(), 'docker-stream-'));
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
  rmSync(socketDir, { recursive: true, force: true });
});

describe('pullImageRefStreaming', () => {
  it('aggregates per-layer progress and reports totals only when fully known', async () => {
    const served = serveNdjson(
      [
        JSON.stringify({ id: 'layer-a', status: 'Downloading', progressDetail: { current: 50 } }),
        JSON.stringify({ id: 'layer-b', status: 'Downloading', progressDetail: { current: 25, total: 100 } }),
        JSON.stringify({ id: 'layer-a', status: 'Downloading', progressDetail: { current: 100, total: 200 } }),
        JSON.stringify({ id: 'layer-a', status: 'Pull complete' }),
        JSON.stringify({ id: 'layer-b', status: 'Pull complete' }),
      ],
      3
    );
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');
    const events: DockerPullProgress[] = [];
    await docker.pullImageRefStreaming('registry.test/core@sha256:abc', (progress) => events.push(progress));
    await served;

    // No event may carry a byte total before every seen layer has one.
    const early = events[0];
    expect(early.totalBytes).toBeUndefined();
    expect(early.layersTotal).toBe(1);
    const last = events.at(-1)!;
    expect(last).toEqual({ layersCompleted: 2, layersTotal: 2, downloadedBytes: 300, totalBytes: 300 });
    // Progress is monotonic.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].layersCompleted!).toBeGreaterThanOrEqual(events[i - 1].layersCompleted!);
    }
  });

  it('treats already-cached layers as completed', async () => {
    const served = serveNdjson([JSON.stringify({ id: 'layer-a', status: 'Already exists' })]);
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');
    const events: DockerPullProgress[] = [];
    await docker.pullImageRefStreaming('registry.test/core@sha256:abc', (p) => events.push(p));
    await served;
    expect(events.at(-1)).toEqual({ layersCompleted: 1, layersTotal: 1 });
  });

  it('keeps byte progress when another layer is already cached without a reported size', async () => {
    const served = serveNdjson([
      JSON.stringify({ id: 'cached-layer', status: 'Pulling fs layer' }),
      JSON.stringify({ id: 'download-layer', status: 'Downloading', progressDetail: { current: 25, total: 100 } }),
      JSON.stringify({ id: 'cached-layer', status: 'Already exists' }),
      JSON.stringify({ id: 'download-layer', status: 'Pull complete' }),
    ]);
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');
    const events: DockerPullProgress[] = [];
    await docker.pullImageRefStreaming('registry.test/core@sha256:abc', (p) => events.push(p));
    await served;

    expect(events.at(-1)).toEqual({
      layersCompleted: 2,
      layersTotal: 2,
      downloadedBytes: 100,
      totalBytes: 100,
    });
  });

  it('rejects when the daemon streams an error', async () => {
    const served = serveNdjson([
      JSON.stringify({ id: 'layer-a', status: 'Downloading', progressDetail: { current: 1, total: 9 } }),
      JSON.stringify({ error: 'manifest unknown' }),
    ]);
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');
    await expect(docker.pullImageRefStreaming('registry.test/core@sha256:abc', () => {})).rejects.toThrow(
      'manifest unknown'
    );
    await served;
  });

  it('preserves the Docker message from a non-200 response', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'no matching manifest for linux/arm64/v8' }));
    });
    server.listen(join(socketDir, 'docker.sock'));
    await new Promise((resolve) => server!.on('listening', resolve));
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');

    await expect(docker.pullImageRefStreaming('registry.test/core@sha256:abc', () => {})).rejects.toThrow(
      'no matching manifest for linux/arm64/v8'
    );
  });

  it('handles a trailing line without a newline', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.write(JSON.stringify({ id: 'layer-a', status: 'Downloading', progressDetail: { current: 5, total: 10 } }));
      res.end(); // no trailing newline
    });
    server.listen(join(socketDir, 'docker.sock'));
    await new Promise((resolve) => server!.on('listening', resolve));
    const docker = new DockerService(join(socketDir, 'docker.sock'), '');
    const events: DockerPullProgress[] = [];
    await docker.pullImageRefStreaming('registry.test/core@sha256:abc', (p) => events.push(p));
    expect(events.at(-1)).toEqual({ layersCompleted: 0, layersTotal: 1, downloadedBytes: 5, totalBytes: 10 });
  });
});
