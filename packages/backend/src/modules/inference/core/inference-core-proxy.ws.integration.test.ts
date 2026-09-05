import 'reflect-metadata';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { container, TOKENS } from '@/container.js';
import { InferenceCoreAccountingService } from '../accounting/inference-core-accounting.service.js';
import { InferenceTokenService } from '../inference-token.service.js';
import { InferenceCoreProxyService } from './inference-core-proxy.service.js';
import { createCoreResponsesWSHandlers } from './inference-core-proxy.ws.js';

vi.mock('@/lib/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger, createChildLogger: () => logger };
});

it('keeps a real Hono WebSocket through a 125-second idle proxy during 180 seconds of model silence', async () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', isBlocked: false, scopes: [] };
  const auth = { user, tokenId: 'token-1', tokenPrefix: 'gwi_test', rawToken: 'fixture-only' };
  const core = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const proxySockets = new Set<Socket>();
  let coreTurns = 0;
  let idleDisconnects = 0;
  core.on('connection', (socket) => {
    let terminal: ReturnType<typeof setTimeout> | undefined;
    socket.once('message', () => {
      coreTurns += 1;
      socket.send(JSON.stringify({ type: 'response.created' }));
      const delay = coreTurns === 2 ? 0 : 180_000;
      terminal = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_fixture' } }));
        }
      }, delay);
    });
    socket.on('close', () => clearTimeout(terminal));
  });
  await once(core, 'listening');
  const coreAddress = core.address();
  if (!coreAddress || typeof coreAddress === 'string') throw new Error('Expected TCP core address');
  const accounting = {
    createCoreRequest: vi.fn().mockResolvedValue({ requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }),
    retargetCoreRequest: vi.fn(),
    finalizeCoreRequest: vi.fn().mockResolvedValue(undefined),
  };
  container.registerInstance(InferenceTokenService, {
    validateToken: vi.fn().mockResolvedValue({ user, tokenId: auth.tokenId, tokenPrefix: auth.tokenPrefix }),
  } as never);
  container.registerInstance(TOKENS.RedisClient, {
    pipeline: vi.fn(() => ({
      zremrangebyscore() {
        return this;
      },
      zcard() {
        return this;
      },
      zadd() {
        return this;
      },
      expire() {
        return this;
      },
      exec: vi.fn().mockResolvedValue([
        [null, 0],
        [null, 0],
        [null, 1],
        [null, 1],
      ]),
    })),
    eval: vi.fn().mockResolvedValue(1),
  } as never);
  container.registerInstance(InferenceCoreAccountingService, accounting as never);
  container.registerInstance(InferenceCoreProxyService, {
    resolveTarget: vi.fn().mockResolvedValue({
      model: { id: 'model-1', publicId: 'gpt-5.5', reasoningEfforts: [], defaultReasoningEffort: null },
      selected: {
        source: { id: 'source-1', reasoningEffortMap: {}, coreAccountId: 'core-1', coreModelId: 'core-1/gpt-5.5' },
        connection: { id: 'conn-1' },
      },
      upstreamModel: 'core-1/gpt-5.5',
      coreAccountId: 'core-1',
      candidateConnectionIds: ['conn-1'],
    }),
    dataPlaneTarget: vi
      .fn()
      .mockResolvedValue({ baseUrl: `http://127.0.0.1:${coreAddress.port}`, credential: 'fixture' }),
  } as never);

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });
  app.get(
    '/responses',
    upgradeWebSocket(() => createCoreResponsesWSHandlers(auth as never))
  );
  const gateway = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false });
  injectWebSocket(gateway);
  await once(gateway, 'listening');
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('Expected TCP gateway address');

  // A byte-transparent proxy with an actual idle deadline, not a mocked heartbeat.
  const edge = createServer((downstream) => {
    const upstream = connect({ host: '127.0.0.1', port: gatewayAddress.port });
    proxySockets.add(downstream);
    proxySockets.add(upstream);
    const close = () => {
      downstream.destroy();
      upstream.destroy();
    };
    downstream.setTimeout(125_000, () => {
      idleDisconnects += 1;
      close();
    });
    downstream.on('error', close);
    upstream.on('error', close);
    downstream.on('close', () => {
      proxySockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on('close', () => {
      proxySockets.delete(upstream);
      downstream.destroy();
    });
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  edge.listen(0, '127.0.0.1');
  await once(edge, 'listening');
  const edgeAddress = edge.address();
  if (!edgeAddress || typeof edgeAddress === 'string') throw new Error('Expected TCP edge address');
  const client = new WebSocket(`ws://127.0.0.1:${edgeAddress.port}/responses`);
  let pings = 0;
  const frames: string[] = [];
  client.on('ping', () => {
    pings += 1;
  });
  client.on('message', (data) => frames.push(JSON.parse(String(data)).type));
  const nextFrame = (type: string) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        client.off('message', message);
        client.off('error', rejectAndClean);
        client.off('close', closed);
      };
      const rejectAndClean = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => rejectAndClean(new Error(`Closed before ${type}`));
      const message = (data: WebSocket.RawData) => {
        if (JSON.parse(String(data)).type === type) {
          cleanup();
          resolve();
        }
      };
      client.on('message', message);
      client.on('error', rejectAndClean);
      client.on('close', closed);
    });
  const request = JSON.stringify({ type: 'response.create', model: 'gpt-5.5', input: 'fixture' });
  try {
    await once(client, 'open');
    const completed = nextFrame('response.completed');
    const startedAt = Date.now();
    client.send(request);
    await completed;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180_000);
    expect(pings).toBeGreaterThanOrEqual(8);
    expect(idleDisconnects).toBe(0);
    expect(frames).toEqual(['response.created', 'response.completed']);
    await vi.waitFor(() =>
      expect(accounting.finalizeCoreRequest).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'completed')
    );

    // Keep the same client connection for the next turn; do not spawn another heartbeat.
    const second = nextFrame('response.completed');
    client.send(request);
    await second;
    expect(coreTurns).toBe(2);
    await vi.waitFor(() => expect(accounting.finalizeCoreRequest).toHaveBeenCalledTimes(2));

    // Cancellation still ends only the active turn, not the client connection.
    client.send(request);
    await vi.waitFor(() => expect(coreTurns).toBe(3));
    const cancelled = nextFrame('response.cancelled');
    client.send('{"type":"response.cancel"}');
    await cancelled;
    await vi.waitFor(() => expect(accounting.finalizeCoreRequest).toHaveBeenCalledTimes(3));
    expect(accounting.finalizeCoreRequest).toHaveBeenLastCalledWith(expect.any(String), 'cancelled');
    expect(client.readyState).toBe(WebSocket.OPEN);
    const closed = once(client, 'close');
    client.close(1000, 'fixture complete');
    await closed;
  } finally {
    client.terminate();
    for (const socket of proxySockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    for (const socket of core.clients) socket.terminate();
    await Promise.all([
      new Promise<void>((resolve) => edge.close(() => resolve())),
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => gateway.close(() => resolve())),
      new Promise<void>((resolve) => core.close(() => resolve())),
    ]);
    container.reset();
  }
}, 195_000);
