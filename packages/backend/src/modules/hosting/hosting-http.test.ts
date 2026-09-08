import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/logger.js', () => ({ logger: { warn: io.warn } }));
vi.mock('node:dns/promises', () => ({ lookup: io.lookup }));
vi.mock('node:https', () => ({ request: io.request }));

import { HostingSettingsSchema } from './hosting.schemas.js';
import { HostingHttpClient, HostingProviderError } from './hosting-http.js';
import { HostkeyHostingAdapter } from './providers/hostkey.js';

function connection(provider: 'digitalocean' | 'proxmox' = 'digitalocean', pin?: string) {
  return {
    provider,
    baseUrl: provider === 'proxmox' ? 'https://pve.test:8006' : 'https://api.digitalocean.com',
    token: 'private-token',
    settings: HostingSettingsSchema.parse(
      provider === 'proxmox' ? { tokenId: 'gw@pve!hosting', clusterId: 'lab', certificateFingerprint: pin } : {}
    ),
  };
}
function response(status: number, data: string, pin = 'a'.repeat(64)) {
  const socket = Object.assign(new EventEmitter(), { getPeerCertificate: () => ({ fingerprint256: pin }) });
  const res = Object.assign(new EventEmitter(), { statusCode: status, resume: vi.fn() });
  const req = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  req.destroy.mockImplementation((error: Error) => {
    req.emit('error', error);
  });
  io.request.mockImplementation((_url, _opts, callback) => {
    req.end.mockImplementation(() => {
      callback(res);
      res.emit('data', Buffer.from(data));
      res.emit('end');
    });
    queueMicrotask(() => req.emit('socket', socket));
    return req;
  });
  return { req, socket, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  io.lookup.mockResolvedValue({ address: '203.0.113.10', family: 4 });
});

describe('Hetzner error diagnostics', () => {
  const client = () =>
    new HostingHttpClient({ ...connection(), provider: 'hetzner', baseUrl: 'https://api.hetzner.cloud' });
  it('explains unavailable configurations without reflecting provider text', async () => {
    const { socket } = response(
      422,
      JSON.stringify({ error: { code: 'resource_unavailable', message: 'private-token secret bootstrap' } })
    );
    const pending = client().request('/v1/servers', { method: 'POST', body: {} });
    await vi.waitFor(() => expect(socket.listenerCount('secureConnect')).toBe(1));
    socket.emit('secureConnect');
    await expect(pending).rejects.toMatchObject({
      outcomeUnknown: false,
      message:
        'Hetzner: Selected server type or image is unavailable in this location. Choose another configuration (resource_unavailable, HTTP 422).',
    });
  });
  it('reports only known invalid field names', async () => {
    const { socket } = response(
      422,
      JSON.stringify({
        error: {
          code: 'invalid_input',
          details: { fields: [{ name: 'server_type', messages: ['secret'] }, { name: 'private-token' }] },
        },
      })
    );
    const pending = client()
      .request('/v1/servers', { method: 'POST' })
      .catch((error) => error);
    await vi.waitFor(() => expect(socket.listenerCount('secureConnect')).toBe(1));
    socket.emit('secureConnect');
    const error = await pending;
    if (!(error instanceof HostingProviderError)) throw new Error('Expected provider rejection');
    expect(error.message).toContain('check server_type');
    expect(error.message).not.toMatch(/secret|private-token/);
  });
  it('does not echo unknown error codes', async () => {
    const { socket } = response(422, JSON.stringify({ error: { code: 'private-token', message: 'private-key' } }));
    const pending = client().request('/v1/servers', { method: 'POST' });
    await vi.waitFor(() => expect(socket.listenerCount('secureConnect')).toBe(1));
    socket.emit('secureConnect');
    await expect(pending).rejects.toMatchObject({ message: 'Provider returned HTTP 422' });
  });
});

function hostkeySequence(...responses: Array<{ status?: number; body: unknown }>) {
  const sent: Array<{ path: string; form: URLSearchParams; authorization?: string }> = [];
  io.request.mockImplementation((url, opts, callback) => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    const socket = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { statusCode: next.status ?? 200, resume: vi.fn() });
    const req = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
    req.end.mockImplementation(() => {
      sent.push({
        path: url.toString(),
        form: new URLSearchParams(req.write.mock.calls[0]?.[0]),
        authorization: opts.headers.Authorization,
      });
      callback(res);
      res.emit('data', Buffer.from(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)));
      res.emit('end');
    });
    queueMicrotask(() => {
      req.emit('socket', socket);
      socket.emit('secureConnect');
    });
    return req;
  });
  return sent;
}
function hostkeyClient() {
  return new HostingHttpClient({
    provider: 'hostkey',
    baseUrl: 'https://invapi.hostkey.com',
    token: 'original-api-key',
    settings: HostingSettingsSchema.parse({}),
  });
}
const hostkeyRead = { method: 'POST' as const, form: { action: 'get_client' }, readOnly: true };
describe('HOSTKEY API key session exchange', () => {
  it('uses the live result-wrapped login session for connector validation and subsequent reads', async () => {
    const sent = hostkeySequence(
      { body: { result: { token: 'wrapped-session', token_expire: Math.floor(Date.now() / 1000) + 3600 } } },
      { body: { result: 'OK', client: { id: 123 }, billing_location: 'whmcs_com' } },
      { body: { result: 'OK', servers: [] } }
    );
    const adapter = new HostkeyHostingAdapter({
      provider: 'hostkey',
      baseUrl: 'https://invapi.hostkey.com',
      token: 'original-api-key',
      settings: HostingSettingsSchema.parse({}),
    });
    await expect(adapter.test()).resolves.toMatchObject({ authority: 'hostkey:whmcs_com:123' });
    expect(sent.map((item) => item.form.get('action'))).toEqual(['login', 'get_client', 'list']);
    expect(sent.slice(1).map((item) => item.form.get('token'))).toEqual(['wrapped-session', 'wrapped-session']);
    expect(io.warn).not.toHaveBeenCalled();
  });
  it('authenticates before connector validation and does not confuse login errors with missing billing access', async () => {
    const sent = hostkeySequence(
      { body: { token: 'session' } },
      { body: { result: 'OK', client: { id: 123 }, billing_location: 'whmcs_com' } },
      { body: { result: 'OK', servers: [] } }
    );
    const adapter = () =>
      new HostkeyHostingAdapter({
        provider: 'hostkey',
        baseUrl: 'https://invapi.hostkey.com',
        token: 'original-api-key',
        settings: HostingSettingsSchema.parse({}),
      });
    await expect(adapter().test()).resolves.toMatchObject({ authority: 'hostkey:whmcs_com:123' });
    expect(sent.map((item) => item.form.get('action'))).toEqual(['login', 'get_client', 'list']);
    const denied = hostkeySequence({ body: { code: -1, message: 'Invalid key' } });
    await expect(adapter().test()).rejects.toMatchObject({ code: 'HOSTING_AUTHENTICATION_FAILED' });
    expect(denied).toHaveLength(1);
  });
  it('exchanges only at the official auth endpoint and never sends the API key to business methods', async () => {
    const sent = hostkeySequence(
      {
        body: {
          token: 'session-token',
          token_expire: Math.floor(Date.now() / 1000) + 3600,
          invapi: 'https://attacker.test',
        },
      },
      { body: { result: 'OK' } },
      { body: { result: 'OK' } }
    );
    const client = hostkeyClient();
    await client.request('/whmcs.php', hostkeyRead);
    await client.request('/eq.php', { method: 'POST', form: { action: 'list' }, readOnly: true });
    expect(sent.map((item) => item.path)).toEqual([
      'https://invapi.hostkey.com/auth.php',
      'https://invapi.hostkey.com/whmcs.php',
      'https://invapi.hostkey.com/eq.php',
    ]);
    expect(Object.fromEntries(sent[0].form)).toEqual({ action: 'login', key: 'original-api-key', ttl: '3600' });
    for (const request of sent.slice(1)) {
      expect(request.form.get('token')).toBe('session-token');
      expect(request.form.toString()).not.toContain('original-api-key');
      expect(request.authorization).toBeUndefined();
    }
  });
  it('shares one login among concurrent reads', async () => {
    const sent = hostkeySequence(
      { body: { token: 'session-token' } },
      { body: { result: 'OK' } },
      { body: { result: 'OK' } }
    );
    const client = hostkeyClient();
    await Promise.all([client.request('/whmcs.php', hostkeyRead), client.request('/whmcs.php', hostkeyRead)]);
    expect(sent.filter((item) => item.form.get('action') === 'login')).toHaveLength(1);
  });
  it('refreshes before a write when the cached session is expiring', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const sent = hostkeySequence(
        { body: { token: 'old', token_expire: Math.floor(now / 1000) + 60 } },
        { body: { result: 'OK' } },
        { body: { token: 'new' } },
        { body: { result: 'OK' } }
      );
      const client = hostkeyClient();
      await client.request('/whmcs.php', hostkeyRead);
      clock.mockReturnValue(now + 40_000);
      await client.request('/eq.php', { method: 'POST', form: { action: 'order' } });
      expect(sent.at(-1)?.form.get('token')).toBe('new');
      expect(sent.filter((item) => item.form.get('action') === 'order')).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([
    { status: 401, body: {} },
    { body: { code: -2, message: 'Invalid token' } },
    { body: { result: -2, error: 'Invalid token' } },
  ])('re-authenticates once after explicit expiry on a read', async (failure) => {
    const sent = hostkeySequence(
      { body: { token: 'old' } },
      failure,
      { body: { token: 'new' } },
      { body: { result: 'OK' } }
    );
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).resolves.toEqual({ result: 'OK' });
    expect(sent.map((item) => item.form.get('action'))).toEqual(['login', 'get_client', 'login', 'get_client']);
    expect(sent.at(-1)?.form.get('token')).toBe('new');
  });
  it('does not loop when the refreshed read session is also rejected', async () => {
    const failure = { code: -2, message: 'Session expired' };
    const sent = hostkeySequence(
      { body: { token: 'old' } },
      { body: failure },
      { body: { token: 'new' } },
      { body: failure }
    );
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).resolves.toEqual(failure);
    expect(sent).toHaveLength(4);
  });
  it.each([401, 403, 500])('never replays a mutation after HTTP %s', async (status) => {
    const sent = hostkeySequence({ body: { token: 'session' } }, { status, body: {} });
    await expect(
      hostkeyClient().request('/eq.php', { method: 'POST', form: { action: 'order' }, readOnly: false })
    ).rejects.toBeInstanceOf(HostingProviderError);
    expect(sent).toHaveLength(2);
  });
  it('never replays a mutation after an expired-session envelope or malformed response', async () => {
    const expired = { code: -2, message: 'Invalid token' };
    const sent = hostkeySequence({ body: { token: 'session' } }, { body: expired });
    await expect(hostkeyClient().request('/eq.php', { method: 'POST', form: { action: 'order' } })).resolves.toEqual(
      expired
    );
    expect(sent).toHaveLength(2);
    const malformed = hostkeySequence({ body: { token: 'session' } }, { body: 'not-json' });
    await expect(
      hostkeyClient().request('/eq.php', { method: 'POST', form: { action: 'order' } })
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(malformed).toHaveLength(2);
  });
  it.each([
    { code: -1, message: 'original-api-key secret-session' },
    { result: -1, error: 'original-api-key secret-session' },
    { token: 'session', result: 'Fail' },
    { token: 'session', token_expire: 1 },
    { result: { token: 'session', token_expire: 1 } },
    { result: { token: 'session' }, code: -1, message: 'original-api-key secret-session' },
    { result: { token: 'session' }, error: 'original-api-key secret-session' },
    { result: { token: 'session', code: -1, message: 'original-api-key secret-session' } },
    { result: { token: 'session', error: 'original-api-key secret-session' } },
    { token: 'session', code: -1, message: 'original-api-key secret-session' },
    { token: 'session', error: 'original-api-key secret-session' },
    { token: 'session', code: '-1' },
    { result: { token: 'session', result: 'failed' } },
  ])('rejects unsuccessful login without dispatch or raw error disclosure', async (body) => {
    const sent = hostkeySequence({ body });
    const error = await hostkeyClient()
      .request('/whmcs.php', hostkeyRead)
      .catch((error) => error);
    expect(error).toMatchObject({ code: 'HOSTING_AUTHENTICATION_FAILED', statusCode: 403 });
    if (!(error instanceof Error)) throw new Error('Expected authentication failure');
    expect(error.message).not.toContain('original-api-key');
    expect(error.message).not.toContain('secret-session');
    expect(sent).toHaveLength(1);
  });
  it('reports the live HOSTKEY key-format rejection instead of a generic permission guess', async () => {
    const sent = hostkeySequence({ body: { result: -1, error: 'Incorrect API key format' } });
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).rejects.toMatchObject({
      code: 'HOSTING_AUTHENTICATION_FAILED',
      message: 'HOSTKEY: incorrect API key format. Paste the full original key, not its displayed hash.',
    });
    expect(sent).toHaveLength(1);
  });
  it.each([
    {},
    { result: 'OK', data: { token: 'secret-session' } },
    { result: { token: 'with whitespace' } },
    { result: { token: '' } },
    { result: { token: 123 } },
    { result: { token: 'x'.repeat(4097) } },
    { result: { result: { token: 'secret-session' } } },
    { token: 'root-session', result: { token: 'different-session' } },
  ])('does not label malformed login responses as permission errors', async (body) => {
    hostkeySequence({ body });
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).rejects.toMatchObject({
      code: 'HOSTING_AUTH_RESPONSE_INVALID',
      statusCode: 502,
    });
  });
  it('logs only fixed schema types for unexpected authentication responses, never keys or values', async () => {
    const sent = hostkeySequence({
      body: {
        token: 'conflicting-session',
        result: { token: 'secret-session', token_expire: 123, email: 'private@example.test' },
        data: { token: 'another-secret' },
        'original-api-key': 'private value',
      },
    });
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).rejects.toMatchObject({
      code: 'HOSTING_AUTH_RESPONSE_INVALID',
    });
    expect(io.warn).toHaveBeenCalledExactlyOnceWith('HOSTKEY login response schema mismatch', {
      root: {
        type: 'object',
        token: 'string',
        tokenExpire: 'undefined',
        result: 'object',
        error: 'undefined',
        message: 'undefined',
      },
      resultEnvelope: {
        type: 'object',
        token: 'string',
        tokenExpire: 'number',
        result: 'undefined',
        error: 'undefined',
        message: 'undefined',
      },
      dataEnvelope: {
        type: 'object',
        token: 'string',
        tokenExpire: 'undefined',
        result: 'undefined',
        error: 'undefined',
        message: 'undefined',
      },
    });
    expect(sent).toHaveLength(1);
  });
  it('does not replay a write for the numeric HOSTKEY session failure envelope', async () => {
    const failure = { result: -2, error: 'Invalid token' };
    const sent = hostkeySequence({ body: { token: 'session' } }, { body: failure });
    await expect(
      hostkeyClient().request('/eq.php', { method: 'POST', form: { action: 'order_instance' }, readOnly: false })
    ).resolves.toEqual(failure);
    expect(sent).toHaveLength(2);
  });
  it('does not refresh on permission denial', async () => {
    const denied = { code: -2, message: 'Permission denied' };
    const sent = hostkeySequence({ body: { token: 'session' } }, { body: denied });
    await expect(hostkeyClient().request('/whmcs.php', hostkeyRead)).resolves.toEqual(denied);
    expect(sent).toHaveLength(2);
  });
});

describe('hosting provider HTTPS boundary', () => {
  it('pins token introspection to the official cloud origin with normal TLS and bearer protection', async () => {
    const { socket } = response(200, JSON.stringify({ scopes: ['droplet:read'] }));
    const beforeRequest = vi.fn(async () => {});
    const promise = new HostingHttpClient({ ...connection(), beforeRequest }).request('/v1/oauth/token/info');
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await expect(promise).resolves.toEqual({ scopes: ['droplet:read'] });
    expect(io.lookup).toHaveBeenCalledWith('cloud.digitalocean.com');
    expect(io.request.mock.calls[0]?.[0].toString()).toBe('https://cloud.digitalocean.com/v1/oauth/token/info');
    expect(io.request.mock.calls[0]?.[1]).toMatchObject({
      servername: 'cloud.digitalocean.com',
      rejectUnauthorized: true,
      headers: { Authorization: 'Bearer private-token' },
    });
    expect(beforeRequest).toHaveBeenCalledOnce();
  });
  it.each([
    { method: 'POST' as const },
    { body: {} },
    { form: {} },
    { query: { token: 'secret' } },
  ])('rejects token-info request mutations or caller parameters', async (options) => {
    await expect(new HostingHttpClient(connection()).request('/v1/oauth/token/info', options)).rejects.toMatchObject({
      code: 'HOSTING_REQUEST_INVALID',
    });
    expect(io.lookup).not.toHaveBeenCalled();
    expect(io.request).not.toHaveBeenCalled();
  });
  it('does not expose an arbitrary cloud-origin override', async () => {
    await expect(
      new HostingHttpClient(connection()).request('https://cloud.digitalocean.com/v1/oauth/token/info')
    ).rejects.toMatchObject({ code: 'HOSTING_REQUEST_INVALID' });
    await expect(
      new HostingHttpClient(connection()).request('//cloud.digitalocean.com/v1/oauth/token/info')
    ).rejects.toMatchObject({ code: 'HOSTING_REQUEST_INVALID' });
    expect(io.request).not.toHaveBeenCalled();
  });
  it('blocks private DNS and redirects for token introspection', async () => {
    io.lookup.mockResolvedValueOnce({ address: '127.0.0.1', family: 4 });
    await expect(new HostingHttpClient(connection()).request('/v1/oauth/token/info')).rejects.toMatchObject({
      code: 'HOSTING_ENDPOINT_BLOCKED',
    });
    expect(io.request).not.toHaveBeenCalled();
    const { socket } = response(302, '');
    const failure = new HostingHttpClient(connection()).request('/v1/oauth/token/info').catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    expect(await failure).toMatchObject({ providerStatus: 302, outcomeUnknown: false });
    expect(io.request).toHaveBeenCalledOnce();
  });
  it('preserves the provider reason from a bounded DO error without reflecting other fields', async () => {
    const { socket } = response(
      403,
      JSON.stringify({ message: 'Access to this action is denied', request: 'private-token' })
    );
    const promise = new HostingHttpClient(connection()).request('/v2/droplets', { method: 'POST', body: {} });
    const failure = promise.catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    const error = await failure;
    if (!(error instanceof HostingProviderError)) throw new Error('Expected rejection');
    expect(error.message).toContain('Access to this action is denied');
    expect(error.message).not.toContain('private-token');
    expect(error.outcomeUnknown).toBe(false);
  });
  it.each([
    JSON.stringify({ message: 'user_data: secret installer' }),
    JSON.stringify({ message: 'bad token gw_node_v2_aaaaaaaa_secret' }),
    JSON.stringify({ message: '-----BEGIN PRIVATE KEY----- secret' }),
    JSON.stringify({ message: 'password=secret' }),
    '<html>private-token</html>',
    'x'.repeat(17000),
  ])('uses the safe fallback for echoed secrets, invalid or oversized DO errors', async (body) => {
    const { socket } = response(403, body);
    const failure = new HostingHttpClient(connection())
      .request('/v2/droplets', { method: 'POST', body: {} })
      .catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    const error = await failure;
    if (!(error instanceof HostingProviderError)) throw new Error('Expected rejection');
    expect(error.message).toContain('droplet:create and tag:create');
    expect(error.message).not.toContain('secret');
    expect(error.outcomeUnknown).toBe(false);
  });
  it('explains DO create permission requirements without exposing provider payloads', async () => {
    const { socket } = response(403, '{"message":"private-token echoed guest credentials"}');
    const promise = new HostingHttpClient(connection()).request('/v2/droplets', {
      method: 'POST',
      body: { name: 'test' },
    });
    const failure = promise.catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    const error = await failure;
    if (!(error instanceof HostingProviderError)) throw new Error('Expected provider rejection');
    expect(error).toMatchObject({ providerStatus: 403, outcomeUnknown: false });
    expect(error.message).toContain('droplet:create and tag:create');
    expect(error.message).not.toContain('private-token');
    expect(error.message).not.toContain('guest credentials');
  });
  it('uploads bounded ISO multipart only after TLS pin validation', async () => {
    const { req, socket } = response(200, '{"data":"UPID:pve:upload"}');
    const promise = new HostingHttpClient(connection('proxmox', 'a'.repeat(64))).request(
      '/api2/json/nodes/pve/storage/local/upload',
      {
        method: 'POST',
        seedIso: {
          filename: 'gateway-seed-gw-11111111-1111-4111-8111-111111111111.iso',
          data: Buffer.from('private-seed'),
        },
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(req.write).not.toHaveBeenCalled();
    socket.emit('secureConnect');
    await promise;
    const body = req.write.mock.calls[0][0] as Buffer;
    expect(body.toString()).toContain('name="content"\r\n\r\niso');
    expect(body.toString()).toContain('private-seed');
    expect(io.request.mock.calls[0][1].headers['Content-Length']).toBe(String(body.length));
    expect(io.request.mock.calls[0][1].headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
  });
  it('refuses unbounded or arbitrary upload names without opening HTTPS', async () => {
    for (const seedIso of [
      { filename: '../../etc/passwd', data: Buffer.from('x') },
      { filename: 'gateway-seed-gw-11111111.iso', data: Buffer.alloc(2 * 1024 * 1024 + 1) },
    ]) {
      await expect(
        new HostingHttpClient(connection('proxmox')).request('/api2/json/nodes/pve/storage/local/upload', {
          method: 'POST',
          seedIso,
        })
      ).rejects.toMatchObject({ code: 'HOSTING_SEED_INVALID' });
    }
    expect(io.request).not.toHaveBeenCalled();
  });
  it('sends no credentials or body until the pinned certificate has been checked', async () => {
    const { req, socket } = response(200, '{"data":true}');
    const promise = new HostingHttpClient(connection('proxmox', 'a'.repeat(64))).request('/api2/json/version', {
      method: 'POST',
      body: { sensitive: 'value' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(req.write).not.toHaveBeenCalled();
    expect(req.end).not.toHaveBeenCalled();
    socket.emit('secureConnect');
    expect(await promise).toEqual({ data: true });
    expect(req.write).toHaveBeenCalledTimes(1);
    expect(io.request.mock.calls[0][1]).toMatchObject({ family: 4, agent: false, rejectUnauthorized: false });
  });
  it('aborts a pin mismatch without sending the token', async () => {
    const { req, socket } = response(200, '{}', 'b'.repeat(64));
    const promise = new HostingHttpClient(connection('proxmox', 'a'.repeat(64))).request('/api2/json/version');
    const rejected = expect(promise).rejects.toMatchObject({
      outcomeUnknown: false,
      message: expect.stringContaining('certificate fingerprint does not match'),
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await rejected;
    expect(req.end).not.toHaveBeenCalled();
    expect(req.write).not.toHaveBeenCalled();
  });
  it('never follows a redirect or leaks a provider error response', async () => {
    const { socket } = response(302, 'private-token');
    const promise = new HostingHttpClient(connection()).request('/v2/droplets');
    const rejected = expect(promise).rejects.toMatchObject({
      providerStatus: 302,
      message: 'Provider returned HTTP 302',
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await rejected;
    expect(io.request).toHaveBeenCalledTimes(1);
    expect(io.request.mock.calls[0][1]).toMatchObject({ rejectUnauthorized: true });
  });
  it('rejects a cross-origin path before DNS resolution', async () => {
    await expect(new HostingHttpClient(connection()).request('//evil.test/steal')).rejects.toMatchObject({
      code: 'HOSTING_REQUEST_INVALID',
    });
    expect(io.lookup).not.toHaveBeenCalled();
  });
  it('blocks loopback, metadata and mapped-loopback destinations but permits configured private Proxmox', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:7f00:0001']) {
      io.lookup.mockResolvedValueOnce({ address, family: address.includes(':') ? 6 : 4 });
      await expect(new HostingHttpClient(connection('proxmox')).request('/api2/json/version')).rejects.toMatchObject({
        code: 'HOSTING_ENDPOINT_BLOCKED',
      });
    }
    expect(io.request).not.toHaveBeenCalled();
    io.lookup.mockResolvedValueOnce({ address: '10.20.0.3', family: 4 });
    const { socket } = response(200, '{}');
    const promise = new HostingHttpClient(connection('proxmox')).request('/api2/json/version');
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await expect(promise).resolves.toEqual({});
  });
  it('marks interrupted mutation responses unknown instead of retrying', async () => {
    const { socket } = response(200, 'invalid-json');
    const promise = new HostingHttpClient(connection()).request('/v2/droplets', {
      method: 'POST',
      body: { name: 'n1' },
    });
    const rejected = expect(promise).rejects.toMatchObject({ outcomeUnknown: true });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await rejected;
    expect(io.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'Proxmox TLS certificate is not trusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'Private CA certificate or Verified certificate fingerprint'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS certificate is not trusted'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'does not match the API hostname'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['CERT_NOT_YET_VALID', 'certificate is not valid yet'],
    ['ECONNREFUSED', 'refused the connection'],
    ['ENETUNREACH', 'network is unreachable'],
    ['EHOSTUNREACH', 'network is unreachable'],
    ['ECONNRESET', 'connection was reset'],
    ['ETIMEDOUT', 'connection timed out'],
    ['EPROTO', 'TLS handshake failed'],
    ['UNRECOGNIZED_private-token', 'Could not establish a secure provider connection'],
  ])('explains %s without exposing raw errors or sending credentials', async (code, message) => {
    const { req } = response(200, '{}');
    const promise = new HostingHttpClient(connection('proxmox')).request('/api2/json/version');
    const rejected = expect(promise).rejects.toMatchObject({
      code: 'HOSTING_PROVIDER_ERROR',
      message: expect.stringContaining(message),
    });
    await new Promise((resolve) => setImmediate(resolve));
    req.emit('error', Object.assign(new Error('private-token gw@pve!hosting private certificate'), { code }));
    await rejected;
    const failure = await promise.catch((error) => error);
    if (!(failure instanceof HostingProviderError)) throw new Error('Expected a provider error');
    expect(failure.message).not.toContain('private-token');
    expect(failure.message).not.toContain('gw@pve!hosting');
    expect(req.end).not.toHaveBeenCalled();
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('explains DNS failure %s before contacting the provider', async (code) => {
    io.lookup.mockRejectedValueOnce(Object.assign(new Error('private-token raw hostname'), { code }));
    const failure = await new HostingHttpClient(connection()).request('/v2/droplets').catch((error) => error);
    if (!(failure instanceof HostingProviderError)) throw new Error('Expected a provider error');
    expect(failure.message).toMatch(/DNS/);
    expect(failure.message).not.toContain('private-token');
    expect(failure.outcomeUnknown).toBe(false);
    expect(io.request).not.toHaveBeenCalled();
  });

  it('explains the request timeout event and preserves unknown mutation outcomes', async () => {
    const { req } = response(200, '{}');
    const promise = new HostingHttpClient(connection()).request('/v2/droplets', { method: 'POST', body: {} });
    const rejected = expect(promise).rejects.toMatchObject({
      outcomeUnknown: true,
      message: expect.stringContaining('connection timed out'),
    });
    await new Promise((resolve) => setImmediate(resolve));
    req.emit('timeout');
    await rejected;
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(io.request).toHaveBeenCalledOnce();
  });

  it('sanitizes synchronous TLS configuration failures', async () => {
    io.request.mockImplementation(() => {
      throw Object.assign(new Error('private-token private certificate'), { code: 'ERR_OSSL_PEM_NO_START_LINE' });
    });
    await expect(new HostingHttpClient(connection('proxmox')).request('/api2/json/version')).rejects.toMatchObject({
      message: expect.stringContaining('Trusted CA certificate is invalid'),
      outcomeUnknown: false,
    });
  });

  it('reports oversized responses without leaking their contents', async () => {
    const { socket } = response(200, 'x'.repeat(8 * 1024 * 1024 + 1));
    const promise = new HostingHttpClient(connection()).request('/v2/droplets');
    const rejected = expect(promise).rejects.toMatchObject({
      message: 'Provider response exceeded the supported size limit.',
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await rejected;
  });

  it.each([
    [401, 'authentication failed'],
    [403, 'denied access'],
    [404, 'endpoint was not found'],
    [429, 'rate limit reached'],
    [503, 'server error'],
  ])('explains provider HTTP %s without exposing the response body', async (status, message) => {
    const { socket } = response(Number(status), 'private-token provider details');
    const promise = new HostingHttpClient(connection()).request('/v2/droplets');
    const rejected = expect(promise).rejects.toMatchObject({
      providerStatus: status,
      message: expect.stringContaining(String(message)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('secureConnect');
    await rejected;
    const failure = await promise.catch((error) => error);
    if (!(failure instanceof HostingProviderError)) throw new Error('Expected a provider error');
    expect(failure.message).not.toContain('private-token');
  });
});
