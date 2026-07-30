import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedFetch } from './inference-pinned-fetch.js';

let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('pinned provider fetch', () => {
  it('connects only to the validated address while preserving the request hostname', async () => {
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ host: request.headers.host }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const url = `http://rebind.invalid:${address.port}/models`;

    const response = await pinnedFetch(
      url,
      { method: 'POST', body: 'test' },
      { url: new URL(url), hostname: 'rebind.invalid', address: '127.0.0.1', family: 4 }
    );

    await expect(response.json()).resolves.toEqual({ host: `rebind.invalid:${address.port}` });
  });
});
