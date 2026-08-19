import { mkdtemp } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { inferenceProxyInstanceId, startInferenceProxy } from './inference-proxy.js';
import type { CliPaths } from './paths.js';

async function fixturePaths(): Promise<CliPaths> {
  const root = await mkdtemp(join(tmpdir(), 'gateway-inference-proxy-'));
  return {
    configDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    profilesFile: join(root, 'config', 'profiles.json'),
    fileCredentialsFile: join(root, 'data', 'credentials.json'),
    runtimeDir: join(root, 'data', 'runtime'),
    runtimeFile: join(root, 'data', 'runtime', 'gateway-cli.js'),
  };
}

describe('local inference proxy', () => {
  it('changes proxy identity when the installed runtime version changes', async () => {
    const paths = await fixturePaths();

    expect(inferenceProxyInstanceId(paths, 'default', 'https://gateway.example/v1', '0.1.4')).not.toBe(
      inferenceProxyInstanceId(paths, 'default', 'https://gateway.example/v1', '0.1.5')
    );
  });

  it('replaces Codex authorization and streams HTTP requests to Gateway', async () => {
    let received: { url?: string; authorization?: string; body?: string } = {};
    const upstream = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received = {
          url: request.url,
          authorization: request.headers.authorization,
          body,
        };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: first\n\n');
        response.end('data: second\n\n');
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startInferenceProxy({
      paths: await fixturePaths(),
      profileName: 'default',
      remoteBaseUrl: `http://127.0.0.1:${upstreamPort}/api/inference/v1`,
      getToken: async () => 'gwi_local-secret',
    });

    try {
      const response = await fetch(`${proxy.baseUrl}/responses?stream=true`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer codex-secret',
          'Content-Type': 'application/json',
          'X-OpenAI-Actor-Authorization': 'Bearer actor-secret',
        },
        body: JSON.stringify({ model: 'test' }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
      expect(received).toEqual({
        url: '/api/inference/v1/responses?stream=true',
        authorization: 'Bearer gwi_local-secret',
        body: JSON.stringify({ model: 'test' }),
      });
    } finally {
      await proxy.close();
      await close(upstream);
    }
  });

  it('replaces authorization and bridges WebSocket traffic', async () => {
    let upgrade: IncomingMessage | undefined;
    const upstream = createServer();
    const upstreamSockets = new WebSocketServer({ server: upstream });
    upstreamSockets.on('connection', (socket, request) => {
      upgrade = request;
      socket.on('message', (data) => socket.send(`gateway:${data.toString()}`));
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startInferenceProxy({
      paths: await fixturePaths(),
      profileName: 'default',
      remoteBaseUrl: `http://127.0.0.1:${upstreamPort}/api/inference/v1`,
      getToken: async () => 'gwi_websocket-secret',
    });
    const client = new WebSocket(`${proxy.baseUrl.replace('http:', 'ws:')}/responses?transport=websocket`, {
      headers: { Authorization: 'Bearer codex-secret' },
    });

    try {
      await onceOpen(client);
      client.send('hello');
      expect(await onceMessage(client)).toBe('gateway:hello');
      expect(upgrade?.url).toBe('/api/inference/v1/responses?transport=websocket');
      expect(upgrade?.headers.authorization).toBe('Bearer gwi_websocket-secret');
    } finally {
      client.terminate();
      for (const socket of upstreamSockets.clients) socket.terminate();
      await proxy.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
      await close(upstream);
    }
  });

  it('cancels the upstream stream when the downstream client disconnects', async () => {
    let upstreamResponse: ServerResponse | undefined;
    let resolveDisconnected!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    const upstream = createServer((_request, response) => {
      upstreamResponse = response;
      response.on('close', () => {
        if (!response.writableEnded) resolveDisconnected();
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startInferenceProxy({
      paths: await fixturePaths(),
      profileName: 'default',
      remoteBaseUrl: `http://127.0.0.1:${upstreamPort}/api/inference/v1`,
      getToken: async () => 'gwi_local-secret',
    });
    const request = httpRequest(`${proxy.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    try {
      const firstChunk = new Promise<void>((resolve, reject) => {
        request.once('response', (response) => {
          response.once('data', () => {
            response.destroy();
            request.destroy();
            resolve();
          });
          response.once('error', reject);
        });
        request.once('error', (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
        });
      });
      request.end(JSON.stringify({ model: 'test' }));
      await firstChunk;
      await Promise.race([
        disconnected,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('upstream stream remained open')), 1_000)),
      ]);
    } finally {
      upstreamResponse?.end();
      await proxy.close();
      await close(upstream);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
}
