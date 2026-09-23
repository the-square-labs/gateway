import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithPinnedAddress, NotificationDispatcherService } from './notification-dispatcher.service.js';

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
});

describe('fetchWithPinnedAddress', () => {
  it('connects to the validated address while preserving the original host header', async () => {
    let receivedHost = '';
    let receivedBody = '';

    server = createServer((req, res) => {
      receivedHost = req.headers.host ?? '';
      req.on('data', (chunk: Buffer) => {
        receivedBody += chunk.toString('utf8');
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');

    const response = await fetchWithPinnedAddress(`http://webhook.example.test:${address.port}/hook`, '127.0.0.1', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'payload',
      signal: new AbortController().signal,
    });

    await expect(response.text()).resolves.toBe('ok');
    expect(response.status).toBe(200);
    expect(receivedHost).toBe(`webhook.example.test:${address.port}`);
    expect(receivedBody).toBe('payload');
  });

  it('sets content length for string request bodies', async () => {
    let receivedContentLength = '';

    server = createServer((req, res) => {
      receivedContentLength = req.headers['content-length'] ?? '';
      req.resume();
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });

    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');

    await fetchWithPinnedAddress(`http://webhook.example.test:${address.port}/hook`, '127.0.0.1', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'payload',
      signal: new AbortController().signal,
    });

    expect(receivedContentLength).toBe('7');
  });
});

describe('NotificationDispatcherService gateway URL', () => {
  it('prefers PUBLIC_URL over MANAGEMENT_DOMAIN for template context', () => {
    const dispatcher = new NotificationDispatcherService(
      {} as any,
      {} as any,
      { PUBLIC_URL: 'https://public.example.com', MANAGEMENT_DOMAIN: 'https://admin.example.com' } as any,
      {} as any
    );

    expect(dispatcher.getGatewayUrl()).toBe('https://public.example.com');
  });

  it('falls back to MANAGEMENT_DOMAIN when PUBLIC_URL is not configured', () => {
    const dispatcher = new NotificationDispatcherService(
      {} as any,
      {} as any,
      { MANAGEMENT_DOMAIN: 'https://admin.example.com' } as any,
      {} as any
    );

    expect(dispatcher.getGatewayUrl()).toBe('https://admin.example.com');
  });
});

describe('NotificationDispatcherService outbox delivery', () => {
  function harness(options: { delivery?: Record<string, unknown> | null; webhook?: Record<string, unknown> | null }) {
    const updates: Array<Record<string, unknown>> = [];
    const inserted: Array<Record<string, unknown>> = [];
    const delivery =
      options.delivery === null
        ? null
        : {
            id: 'delivery-1',
            webhookId: 'hook-1',
            requestUrl: 'https://hooks.example.test/old-token',
            requestMethod: 'POST',
            requestBody: '{"ok":true}',
            attempt: 0,
            maxAttempts: 5,
            status: 'pending',
            ...options.delivery,
          };
    const webhook =
      options.webhook === null
        ? null
        : {
            id: 'hook-1',
            url: 'https://hooks.example.test/old-token',
            enabled: true,
            headers: { Authorization: 'Bearer current' },
            signingSecret: 'encrypted',
            signingHeader: null,
            ...options.webhook,
          };
    let claimed = false;
    const db = {
      insert: () => ({
        values: (rows: Array<Record<string, unknown>>) => ({
          returning: async () => {
            inserted.push(...rows);
            return rows.map((_row, index) => ({ id: `delivery-${index + 1}` }));
          },
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => {
            updates.push(patch);
            const result = Promise.resolve(undefined);
            return Object.assign(result, {
              returning: async () => {
                if (!delivery || claimed) return [];
                claimed = true;
                return [delivery];
              },
            });
          },
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (webhook ? [webhook] : []) }) }) }),
    };
    const dispatcher = new NotificationDispatcherService(
      db as any,
      { decryptSigningSecret: () => 'secret' } as any,
      { PUBLIC_URL: 'https://gateway.example.test' } as any,
      {} as any
    );
    const send = vi.fn(async (..._args: unknown[]) => ({ status: 200, text: async () => 'ok' }));
    (dispatcher as any).fetchAllowedWebhookTarget = send;
    return { dispatcher, db, updates, inserted, send };
  }

  const event = {
    type: 'alert.fired' as const,
    title: 'CPU',
    message: 'CPU high',
    severity: 'critical' as const,
    resource: { type: 'node', id: 'node-1', key: 'node-1', name: 'node-1' },
    context: { notification: { message: 'CPU high' }, gateway: { url: '' } },
    timestamp: '2026-04-01T00:00:00.000Z',
  };

  it('queues rendered deliveries in the caller transaction without sending', async () => {
    const { dispatcher, db, inserted, send } = harness({});
    const ids = await dispatcher.enqueue(
      db as any,
      [
        {
          id: 'hook-1',
          url: 'https://hooks.example.test/token',
          method: 'POST',
          bodyTemplate: '{{notification.message}}',
          headers: {},
          signingSecret: null,
          signingHeader: null,
        },
      ],
      event as any
    );

    expect(ids).toEqual(['delivery-1']);
    expect(inserted[0]).toMatchObject({
      webhookId: 'hook-1',
      status: 'pending',
      attempt: 0,
      requestUrl: 'https://hooks.example.test/token',
      requestBody: 'CPU high',
      nextRetryAt: expect.any(Date),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a claimed delivery to the current webhook URL with current credentials', async () => {
    const { dispatcher, updates, send } = harness({});

    await dispatcher.retryDelivery('delivery-1');

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe('https://hooks.example.test/old-token');
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer current', 'X-Signature-256': expect.stringMatching(/^sha256=/) },
      body: '{"ok":true}',
    });
    expect(updates.at(-1)).toMatchObject({ status: 'success', attempt: 1 });
  });

  it.each([
    [{ url: 'https://hooks.example.test/new-token' }, 'Webhook URL changed after this delivery was queued'],
    [{ enabled: false }, 'Webhook is disabled'],
  ])('fails instead of sending when the webhook changed (%j)', async (webhookPatch, reason) => {
    const { dispatcher, updates, send } = harness({ webhook: webhookPatch });

    await dispatcher.retryDelivery('delivery-1');

    expect(send).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: 'failed', error: reason });
  });

  it('does not send a delivery another worker already claimed', async () => {
    const { dispatcher, send } = harness({});

    await Promise.all([dispatcher.retryDelivery('delivery-1'), dispatcher.retryDelivery('delivery-1')]);

    expect(send).toHaveBeenCalledOnce();
  });
});
