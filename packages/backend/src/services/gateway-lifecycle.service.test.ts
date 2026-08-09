import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { GatewayLifecycleService } from './gateway-lifecycle.service.js';

describe('GatewayLifecycleService', () => {
  it('applies the phased admission matrix', () => {
    const lifecycle = new GatewayLifecycleService();
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('POST', '/api/users'))).toBe(true);

    lifecycle.transition('draining_user');
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/health'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('HEAD', '/health'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('POST', '/health'))).toBe(false);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/api/public/status-page'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('HEAD', '/api/public/status-page'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('POST', '/api/logging/ingest'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('POST', '/api/logging/ingest/batch'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/api/logging/ingest'))).toBe(false);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/api/users'))).toBe(false);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/api/ws'))).toBe(false);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/', true))).toBe(true);

    lifecycle.transition('draining_logs');
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('POST', '/api/logging/ingest/batch'))).toBe(false);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/health'))).toBe(true);
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/', true))).toBe(true);

    lifecycle.transition('terminating');
    expect(lifecycle.shouldAdmit(lifecycle.classifyRequest('GET', '/health'))).toBe(false);
  });

  it('tracks response completion and does not count newly denied requests', async () => {
    const lifecycle = new GatewayLifecycleService();
    const response = new EventEmitter();
    lifecycle.trackHttpRequest(
      { method: 'GET', url: '/api/users', socket: { destroy() {} } } as never,
      response as never
    );
    expect(lifecycle.getActiveCount('user')).toBe(1);
    lifecycle.transition('draining_user');
    const deniedResponse = new EventEmitter();
    lifecycle.trackHttpRequest(
      { method: 'GET', url: '/api/users', socket: { destroy() {} } } as never,
      deniedResponse as never
    );
    expect(lifecycle.getActiveCount('user')).toBe(1);
    response.emit('finish');
    await expect(lifecycle.waitForZero('user', Date.now() + 100)).resolves.toBe(true);
  });

  it('keeps streaming responses active until finish and handles client close exactly once', () => {
    const lifecycle = new GatewayLifecycleService();
    const streamingResponse = new EventEmitter();
    const abortedResponse = new EventEmitter();
    const streamingSocket = { destroy() {} };
    const abortedSocket = { destroy() {} };

    lifecycle.trackHttpRequest(
      { method: 'GET', url: '/api/events', socket: streamingSocket } as never,
      streamingResponse as never
    );
    lifecycle.trackHttpRequest(
      { method: 'GET', url: '/api/report', socket: abortedSocket } as never,
      abortedResponse as never
    );
    expect(lifecycle.getActiveCount('user')).toBe(2);

    abortedResponse.emit('close');
    abortedResponse.emit('finish');
    expect(lifecycle.getActiveCount('user')).toBe(1);

    streamingResponse.emit('finish');
    expect(lifecycle.getActiveCount('user')).toBe(0);
  });

  it('force closes only sockets in the requested traffic class', () => {
    const lifecycle = new GatewayLifecycleService();
    const userResponse = new EventEmitter();
    const logResponse = new EventEmitter();
    const userSocket = { destroy: vi.fn() };
    const logSocket = { destroy: vi.fn() };

    lifecycle.trackHttpRequest(
      { method: 'GET', url: '/api/users', socket: userSocket } as never,
      userResponse as never
    );
    lifecycle.trackHttpRequest(
      { method: 'POST', url: '/api/logging/ingest', socket: logSocket } as never,
      logResponse as never
    );

    lifecycle.forceClose('user');
    expect(userSocket.destroy).toHaveBeenCalledOnce();
    expect(logSocket.destroy).not.toHaveBeenCalled();
  });

  it('does not track status-host responses as user traffic', () => {
    const lifecycle = new GatewayLifecycleService();
    const response = new EventEmitter();
    const socket = { destroy: vi.fn() };

    lifecycle.trackHttpRequest({ method: 'GET', url: '/', socket } as never, response as never, true);
    lifecycle.transition('draining_user');
    lifecycle.forceClose('user');

    expect(lifecycle.getActiveCount('user')).toBe(0);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
