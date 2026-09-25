import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { EventBusService } from '@/services/event-bus.service.js';

const resolveWebSocketCredentialContext = vi.fn();

vi.mock('@/modules/auth/websocket-auth.js', () => ({ resolveWebSocketCredentialContext }));

const { authenticateEventsConnection, createEventsWSHandlers } = await import('./events.ws.js');

describe('Events WebSocket authentication', () => {
  it('never delivers an unrelated domain to a resource-scoped subscriber', async () => {
    const bus = new EventBusService();
    container.registerInstance(EventBusService, bus);
    const scopes = ['domains:view:domain-a'];
    resolveWebSocketCredentialContext.mockResolvedValue({ user: { id: 'u1', scopes }, scopes });
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);
    await authenticateEventsConnection(ws as never, 'session');
    await handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['domain.changed'] }) }),
      ws as never
    );
    bus.publish('domain.changed', { id: 'domain-b', domain: 'secret.test', action: 'updated' });
    bus.publish('domain.changed', { id: 'domain-a', domain: 'allowed.test', action: 'updated' });
    const events = ws.send.mock.calls
      .map(([message]) => JSON.parse(message))
      .filter((message) => message.type === 'event');
    expect(events).toEqual([
      {
        type: 'event',
        channel: 'domain.changed',
        payload: { id: 'domain-a', domain: 'allowed.test', action: 'updated' },
      },
    ]);
    handlers.onClose(new Event('close'), ws as never);
  });
  beforeEach(() => {
    resolveWebSocketCredentialContext.mockReset();
  });

  afterEach(() => {
    container.reset();
    vi.useRealTimers();
  });

  it('refreshes folder membership before delivery and drops a resource moved outside the grant', async () => {
    const bus = new EventBusService();
    container.registerInstance(EventBusService, bus);
    let scopes = ['pages:view:folder/f1', 'pages:view:p1'];
    resolveWebSocketCredentialContext.mockImplementation(async () => ({ user: { id: 'u1', scopes }, scopes }));
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);
    await authenticateEventsConnection(ws as never, 'session');
    await handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['pages.project.changed'] }) }),
      ws as never
    );
    scopes = ['pages:view:folder/f1'];
    // A move changes folder membership, so the cached scopes are re-resolved before delivery.
    bus.publish('pages.project.changed', { projectId: 'p1', name: 'secret', action: 'moved' });
    await vi.waitFor(() => expect(resolveWebSocketCredentialContext).toHaveBeenCalledTimes(2));
    expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).not.toContainEqual(
      expect.objectContaining({ type: 'event' })
    );
    scopes = ['pages:view:folder/f1', 'pages:view:p2'];
    bus.publish('pages.project.changed', { projectId: 'p2', name: 'new project', action: 'created' });
    await vi.waitFor(() =>
      expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
        type: 'event',
        channel: 'pages.project.changed',
        payload: { projectId: 'p2', name: 'new project', action: 'created' },
      })
    );
    handlers.onClose(new Event('close'), ws as never);
  });

  it('reuses expanded folder scopes for a few seconds instead of re-resolving on every event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const bus = new EventBusService();
    container.registerInstance(EventBusService, bus);
    const scopes = ['pages:view:folder/f1', 'pages:view:p1'];
    resolveWebSocketCredentialContext.mockImplementation(async () => ({ user: { id: 'u1', scopes }, scopes }));
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);
    await authenticateEventsConnection(ws as never, 'session');
    await handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['pages.project.changed'] }) }),
      ws as never
    );
    const delivered = () =>
      ws.send.mock.calls.map(([message]) => JSON.parse(message)).filter((message) => message.type === 'event');

    // A burst of ordinary updates (health, deploys) is filtered with the cached scopes: no extra queries.
    for (let index = 0; index < 50; index += 1) {
      bus.publish('pages.project.changed', { projectId: index % 2 ? 'p1' : 'other', action: 'updated' });
    }
    expect(resolveWebSocketCredentialContext).toHaveBeenCalledTimes(1);
    expect(delivered()).toHaveLength(25);
    expect(delivered().every((message) => message.payload.projectId === 'p1')).toBe(true);

    // Once the cache expires the next event re-resolves once, and queued events share that refresh.
    vi.setSystemTime(Date.now() + 6_000);
    bus.publish('pages.project.changed', { projectId: 'p1', action: 'updated' });
    bus.publish('pages.project.changed', { projectId: 'p1', action: 'updated' });
    await vi.waitFor(() => expect(delivered()).toHaveLength(27));
    expect(resolveWebSocketCredentialContext).toHaveBeenCalledTimes(2);
    handlers.onClose(new Event('close'), ws as never);
  });

  it('delivers pages folder layout events to folder-only users', async () => {
    const bus = new EventBusService();
    container.registerInstance(EventBusService, bus);
    const scopes = ['pages:view:folder/f1'];
    resolveWebSocketCredentialContext.mockImplementation(async () => ({ user: { id: 'u1', scopes }, scopes }));
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);
    await authenticateEventsConnection(ws as never, 'session');
    await handlers.onMessage(
      new MessageEvent('message', { data: JSON.stringify({ type: 'subscribe', channels: ['pages.folder.changed'] }) }),
      ws as never
    );
    bus.publish('pages.folder.changed', { action: 'folder_created', folderId: 'f2' });
    await vi.waitFor(() =>
      expect(ws.send.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
        type: 'event',
        channel: 'pages.folder.changed',
        payload: { action: 'folder_created', folderId: 'f2' },
      })
    );
    handlers.onClose(new Event('close'), ws as never);
  });

  it('sends keepalive traffic before a ten-second idle timeout can close the socket', async () => {
    vi.useFakeTimers();
    const ws = { send: vi.fn(), close: vi.fn() };
    const handlers = createEventsWSHandlers();
    handlers.onOpen(new Event('open'), ws as never);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
    handlers.onClose(new Event('close'), ws as never);
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
