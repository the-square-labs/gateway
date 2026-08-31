import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveWebSocketCredentialContext = vi.fn();

vi.mock('@/modules/auth/websocket-auth.js', () => ({ resolveWebSocketCredentialContext }));

const { authenticateEventsConnection, createEventsWSHandlers } = await import('./events.ws.js');

describe('Events WebSocket authentication', () => {
  beforeEach(() => {
    resolveWebSocketCredentialContext.mockReset();
  });

  it('routes session authentication through the shared WebSocket policy', async () => {
    resolveWebSocketCredentialContext.mockResolvedValue(null);
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    await authenticateEventsConnection(ws as never, 'session-id');

    expect(resolveWebSocketCredentialContext).toHaveBeenCalledWith({
      type: 'session',
      value: 'session-id',
    });
    expect(ws.close).toHaveBeenCalledWith(4001, 'unauthenticated');
    handlers.onClose(new Event('close'), ws as never);
  });

  it('closes a connection that exceeds the pre-auth message budget', () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    for (let index = 0; index < 33; index += 1) {
      handlers.onMessage(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'subscribe', channels: [`node.changed.${index}`] }),
        }),
        ws as never
      );
    }

    expect(ws.close).toHaveBeenCalledWith(4008, 'pre-auth message limit exceeded');
    handlers.onClose(new Event('close'), ws as never);
  });

  it('closes a connection that sends an oversized frame', () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    handlers.onMessage(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'subscribe', channels: ['x'.repeat(70 * 1024)] }),
      }),
      ws as never
    );

    expect(ws.close).toHaveBeenCalledWith(4008, 'message too large');
    handlers.onClose(new Event('close'), ws as never);
  });

  it('counts pre-auth ping frames against the connection budget', () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    for (let index = 0; index < 33; index += 1) {
      handlers.onMessage(new MessageEvent('message', { data: JSON.stringify({ type: 'ping' }) }), ws as never);
    }

    expect(ws.close).toHaveBeenCalledWith(4008, 'pre-auth message limit exceeded');
    handlers.onClose(new Event('close'), ws as never);
  });

  it('counts malformed pre-auth frames against the connection budget', () => {
    const ws = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    for (let index = 0; index < 33; index += 1) {
      handlers.onMessage(new MessageEvent('message', { data: '{' }), ws as never);
    }

    expect(ws.close).toHaveBeenCalledWith(4008, 'pre-auth message limit exceeded');
    handlers.onClose(new Event('close'), ws as never);
  });
});
