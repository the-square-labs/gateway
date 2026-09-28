import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCKER_REQUEST_DEFAULT_TIMEOUT_MS, DockerService } from './docker.service.js';

let socketDir = '';
let server: http.Server | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

describe('Docker socket request timeouts', () => {
  it('bounds a call without its own timeout by the Docker default, not the 5 s agent idle timeout', async () => {
    socketDir = mkdtempSync(join(tmpdir(), 'docker-timeout-'));
    const socketPath = join(socketDir, 'docker.sock');
    server = http.createServer((_req, res) => {
      res.statusCode = 201;
      res.end(JSON.stringify({ Id: 'container-1' }));
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const request = vi.spyOn(http, 'request');

    await expect(new DockerService(socketPath, '').createContainer({ Image: 'clickhouse' } as never)).resolves.toBe(
      'container-1'
    );

    expect(request.mock.calls[0]?.[0]).toMatchObject({ timeout: DOCKER_REQUEST_DEFAULT_TIMEOUT_MS });
  });
});
