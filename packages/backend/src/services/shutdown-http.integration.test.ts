import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayLifecycleService } from './gateway-lifecycle.service.js';
import { ShutdownCoordinator } from './shutdown-coordinator.service.js';

describe('graceful shutdown HTTP integration', () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = null;
  });

  it('drains accepted work while preserving health, frozen status, and phased log admission', async () => {
    const lifecycle = new GatewayLifecycleService();
    const frozenStatus = { generatedAt: '2026-08-09T12:00:00.000Z', overallStatus: 'operational' };
    let slowUserResponse: ServerResponse | null = null;
    let slowLogResponse: ServerResponse | null = null;
    let userAccepted!: () => void;
    let logAccepted!: () => void;
    const userReady = new Promise<void>((resolve) => (userAccepted = resolve));
    const logReady = new Promise<void>((resolve) => (logAccepted = resolve));

    server = createServer((request, response) => {
      lifecycle.trackHttpRequest(request, response);
      const path = new URL(request.url ?? '/', 'http://gateway.test').pathname;
      const trafficClass = lifecycle.classifyRequest(request.method ?? 'GET', path);
      if (!lifecycle.shouldAdmit(trafficClass)) {
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '1',
          connection: 'close',
        });
        response.end(JSON.stringify({ code: 'SERVICE_RESTARTING', message: 'Gateway is restarting' }));
        return;
      }
      response.setHeader('connection', 'close');
      if (path === '/slow-user') {
        slowUserResponse = response;
        response.writeHead(200);
        response.flushHeaders();
        userAccepted();
        return;
      }
      if (path === '/api/logging/ingest') {
        slowLogResponse = response;
        response.writeHead(202);
        response.flushHeaders();
        logAccepted();
        return;
      }
      if (path === '/health') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ok', lifecycleState: lifecycle.getState() }));
        return;
      }
      if (path === '/api/public/status-page') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(frozenStatus));
        return;
      }
      response.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const userRequest = fetch(`${baseUrl}/slow-user`);
    await userReady;
    let releaseUserDrain!: () => void;
    const userDrain = new Promise<void>((resolve) => (releaseUserDrain = resolve));
    const exit = vi.fn();
    const phaseEvents: string[] = [];
    const coordinator = new ShutdownCoordinator({
      lifecycle,
      getSettings: () => ({
        userRequestDrainSeconds: 2,
        structuredLogDrainSeconds: 2,
        finalizationTimeoutSeconds: 5,
      }),
      hooks: {
        freezeStatusPage: async () => {
          phaseEvents.push('status_frozen');
        },
        quiesce: async () => {
          phaseEvents.push('producers_stopped');
        },
        drainUserWork: () => userDrain,
        forceCloseUserWork: async () => {
          phaseEvents.push('user_forced');
        },
        closeLogging: async () => {
          phaseEvents.push('logging_closed');
        },
        closeHttp: async () => {
          phaseEvents.push('http_closed');
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        },
        finalize: async () => {
          phaseEvents.push('dependencies_closed');
        },
        closeApplicationLogger: async () => {
          phaseEvents.push('logger_closed');
        },
      },
      exit,
    });

    const stopping = coordinator.request('SIGTERM');
    expect(lifecycle.getState()).toBe('draining_user');

    const rejected = await fetch(`${baseUrl}/new-user`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    await expect(rejected.json()).resolves.toMatchObject({ code: 'SERVICE_RESTARTING' });
    await expect(fetch(`${baseUrl}/health`).then((response) => response.json())).resolves.toMatchObject({
      lifecycleState: 'draining_user',
    });
    await expect(fetch(`${baseUrl}/api/public/status-page`).then((response) => response.json())).resolves.toEqual(
      frozenStatus
    );

    const logRequest = fetch(`${baseUrl}/api/logging/ingest`, { method: 'POST' });
    await logReady;
    slowUserResponse!.end('completed');
    await expect(userRequest.then((response) => response.text())).resolves.toBe('completed');
    releaseUserDrain();
    await waitForState(lifecycle, 'draining_logs');

    const rejectedLog = await fetch(`${baseUrl}/api/logging/ingest`, { method: 'POST' });
    expect(rejectedLog.status).toBe(503);
    await expect(fetch(`${baseUrl}/health`).then((response) => response.json())).resolves.toMatchObject({
      lifecycleState: 'draining_logs',
    });
    await expect(fetch(`${baseUrl}/api/public/status-page`).then((response) => response.json())).resolves.toEqual(
      frozenStatus
    );

    slowLogResponse!.end('accepted');
    await expect(logRequest.then((response) => response.text())).resolves.toBe('accepted');
    await stopping;

    expect(exit).toHaveBeenLastCalledWith(0);
    expect(phaseEvents).toEqual([
      'status_frozen',
      'producers_stopped',
      'user_forced',
      'logging_closed',
      'http_closed',
      'dependencies_closed',
      'logger_closed',
    ]);
  });

  it('preserves an in-flight response served from the public status host during user drain', async () => {
    const lifecycle = new GatewayLifecycleService();
    let statusResponse: ServerResponse | null = null;
    let statusAccepted!: () => void;
    const statusReady = new Promise<void>((resolve) => (statusAccepted = resolve));

    server = createServer((request, response) => {
      const isStatusHost = request.headers.host === 'status.example.test';
      lifecycle.trackHttpRequest(request, response, isStatusHost);
      statusResponse = response;
      response.writeHead(200, { connection: 'close' });
      response.flushHeaders();
      statusAccepted();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port');

    const statusRequest = new Promise<string>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/',
          headers: { host: 'status.example.test' },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => resolve(body));
        }
      );
      request.on('error', reject);
      request.end();
    });
    await statusReady;

    lifecycle.transition('draining_user');
    lifecycle.forceClose('user');
    statusResponse!.end('frozen status');

    await expect(statusRequest).resolves.toBe('frozen status');
    expect(lifecycle.getActiveCount('user')).toBe(0);
  });
});

async function waitForState(lifecycle: GatewayLifecycleService, state: 'draining_logs'): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (lifecycle.getState() !== state && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(lifecycle.getState()).toBe(state);
}
