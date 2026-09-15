import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerService } from './docker.service.js';

let scratch = '';
let server: http.Server | null = null;

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  const socket = join(scratch, 'docker.sock');
  server.listen(socket);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  return socket;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'docker-archive-stream-'));
});

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Docker archive streaming', () => {
  it('removes disposable containers together with their anonymous volumes', async () => {
    let requestUrl = '';
    const socket = await listen((req, res) => {
      requestUrl = req.url ?? '';
      res.statusCode = 204;
      res.end();
    });
    const docker = new DockerService(socket, '');

    await docker.removeContainer('helper', { removeAnonymousVolumes: true });

    expect(requestUrl).toBe('/v1.46/containers/helper?force=true&v=true');
  });

  it('downloads an archive directly to a file and enforces the streaming byte ceiling', async () => {
    const payload = Buffer.alloc(128 * 1024, 0x61);
    const socket = await listen((_req, res) => {
      res.statusCode = 200;
      for (let offset = 0; offset < payload.length; offset += 4096) {
        res.write(payload.subarray(offset, offset + 4096));
      }
      res.end();
    });
    const docker = new DockerService(socket, '');
    const destination = join(scratch, 'state.tar');

    await expect(docker.getContainerArchiveToFile('core', '/state', destination, payload.length)).resolves.toBe(
      payload.length
    );
    expect(readFileSync(destination)).toEqual(payload);
  });

  it('aborts an archive download that crosses the byte ceiling', async () => {
    const socket = await listen((_req, res) => {
      res.statusCode = 200;
      res.end(Buffer.alloc(32 * 1024, 0x62));
    });
    const docker = new DockerService(socket, '');

    await expect(
      docker.getContainerArchiveToFile('core', '/state', join(scratch, 'oversized.tar'), 1024)
    ).rejects.toThrow('exceeds the 1024-byte limit');
  });

  it('uploads an archive from a file without constructing a request Buffer', async () => {
    const payload = Buffer.alloc(96 * 1024, 0x63);
    const source = join(scratch, 'restore.tar');
    writeFileSync(source, payload);
    let received = Buffer.alloc(0);
    const socket = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = Buffer.concat(chunks);
        res.statusCode = 200;
        res.end();
      });
    });
    const docker = new DockerService(socket, '');

    await docker.putContainerArchiveFromFile('core', '/', source);
    expect(received).toEqual(payload);
  });

  it('bounds total archive time even while bytes keep arriving and closes the output before rejecting', async () => {
    let disconnected = false;
    const socket = await listen((_req, res) => {
      res.write(Buffer.alloc(64));
      const trickle = setInterval(() => res.write(Buffer.alloc(64)), 5);
      res.once('close', () => {
        clearInterval(trickle);
        disconnected = true;
      });
    });
    const destination = join(scratch, 'slow.tar');
    const started = Date.now();
    await expect(
      new DockerService(socket, '').getContainerArchiveToFile('core', '/state', destination, 1024 * 1024, 100)
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    const size = statSync(destination).size;
    await vi.waitFor(() => expect(disconnected).toBe(true));
    expect(statSync(destination).size).toBe(size);
  });
});
