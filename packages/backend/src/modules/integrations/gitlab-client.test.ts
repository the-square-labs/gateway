import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabClient } from './gitlab-client.js';

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  return `http://127.0.0.1:${address.port}`;
}

describe('GitLabClient', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('downloads binary responses without using fetch when no fetch override is injected', async () => {
    const baseUrl = await listen((request, response) => {
      expect(request.url).toBe('/api/v4/projects/28/repository/archive.tar.gz?sha=main');
      expect(request.headers['private-token']).toBe('glpat-token');
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.from([0x1f, 0x8b, 0x08]));
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');
    const archive = await client.requestBuffer('/projects/28/repository/archive.tar.gz', {
      query: { sha: 'main' },
      maxBytes: 1024,
    });

    expect(archive).toEqual({
      buffer: Buffer.from([0x1f, 0x8b, 0x08]),
      contentType: 'application/octet-stream',
    });
  });

  it('bounds native error response buffering while preserving the error preview', async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(502, { 'content-type': 'text/plain' });
      response.write('upstream failure: ');
      response.end('x'.repeat(512 * 1024));
    });
    const client = new GitLabClient(baseUrl, 'glpat-token');

    await expect(client.requestBuffer('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'GITLAB_API_ERROR',
      details: expect.objectContaining({ body: expect.stringContaining('upstream failure:') }),
    });
  });

  it('streams archive responses in bounded chunks without materializing a full Buffer', async () => {
    const payload = Buffer.alloc(600 * 1024, 7);
    const baseUrl = await listen((request, response) => {
      expect(request.headers['private-token']).toBe('glpat-token');
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(payload.byteLength) });
      response.write(payload.subarray(0, 300 * 1024));
      response.end(payload.subarray(300 * 1024));
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');
    const archive = await client.requestStream('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 * 1024 });
    const chunks: Buffer[] = [];
    for await (const chunk of archive.chunks) chunks.push(chunk);

    expect(chunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(payload);
  });

  it('preserves the token across same-origin archive redirects', async () => {
    const baseUrl = await listen((request, response) => {
      expect(request.headers['private-token']).toBe('glpat-token');
      if (request.url?.startsWith('/api/v4/projects/28/repository/archive.tar.gz')) {
        response.writeHead(302, { location: '/archive/download' });
        response.end();
        return;
      }
      expect(request.url).toBe('/archive/download');
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end('archive');
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');
    const archive = await client.requestBuffer('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 });

    expect(archive.buffer.toString()).toBe('archive');
  });

  it('strips the token from cross-origin archive redirects', async () => {
    const downloadUrl = await listen((request, response) => {
      expect(request.url).toBe('/archive/download');
      expect(request.headers['private-token']).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end('archive');
    });
    const baseUrl = await listen((request, response) => {
      expect(request.headers['private-token']).toBe('glpat-token');
      response.writeHead(302, { location: `${downloadUrl}/archive/download` });
      response.end();
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');
    const archive = await client.requestBuffer('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 });

    expect(archive.buffer.toString()).toBe('archive');
  });

  it('strips the token from cross-origin JSON API redirects', async () => {
    const targetUrl = await listen((request, response) => {
      expect(request.url).toBe('/redirected-user');
      expect(request.headers['private-token']).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 42, username: 'alice' }));
    });
    const baseUrl = await listen((request, response) => {
      expect(request.url).toBe('/api/v4/user');
      expect(request.headers['private-token']).toBe('glpat-token');
      response.writeHead(302, { location: `${targetUrl}/redirected-user` });
      response.end();
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');

    await expect(client.request('/user')).resolves.toEqual({ id: 42, username: 'alice' });
  });

  it('rejects cross-origin redirects for requests with sensitive bodies', async () => {
    const targetRequest = vi.fn<http.RequestListener>((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const targetUrl = await listen(targetRequest);
    const baseUrl = await listen((_request, response) => {
      response.writeHead(302, { location: `${targetUrl}/collect` });
      response.end();
    });

    const client = new GitLabClient(baseUrl, 'glpat-token');

    await expect(
      client.request('/projects/28/variables', {
        method: 'POST',
        body: { key: 'DEPLOY_TOKEN', value: 'sensitive-value' },
      })
    ).rejects.toMatchObject({ code: 'GITLAB_REDIRECT_CROSS_ORIGIN' });
    expect(targetRequest).not.toHaveBeenCalled();
  });

  it('rejects redirects containing embedded credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://user:password@downloads.example.test/archive.tar.gz' },
      })
    );
    const client = new GitLabClient('https://gitlab.example.test', 'glpat-token', fetchImpl);

    await expect(
      client.requestBuffer('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 })
    ).rejects.toMatchObject({ code: 'GITLAB_REDIRECT_CREDENTIALS' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects HTTPS to HTTP archive redirects before following them', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://downloads.example.test/archive.tar.gz' },
      })
    );
    const client = new GitLabClient('https://gitlab.example.test', 'glpat-token', fetchImpl);

    await expect(
      client.requestBuffer('/projects/28/repository/archive.tar.gz', { maxBytes: 1024 })
    ).rejects.toMatchObject({ code: 'GITLAB_REDIRECT_DOWNGRADE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
