import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeGrpc = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class TunnelStream {
    private readonly listeners = new Map<string, Set<Listener>>();
    write = vi.fn(() => true);
    pause = vi.fn();
    resume = vi.fn();
    cancel = vi.fn();
    end = vi.fn();

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }
  const admins: Array<{
    credentials: { ca: Buffer; key: Buffer; certificate: Buffer };
    closed: boolean;
    ReloadIdentity: (
      _request: { operationId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) => void;
    CommitIdentityRotation: (
      _request: { operationId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) => void;
    GetRouteRuntime: (
      _request: { routeId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) => void;
    close: () => void;
  }> = [];
  const brokers: Array<{ tunnel: TunnelStream; closed: boolean }> = [];
  const reloadRequests: string[] = [];
  const commitRequests: string[] = [];
  let commitFailures = 0;
  class RelayAdmin {
    credentials: { ca: Buffer; key: Buffer; certificate: Buffer };
    closed = false;

    constructor(_target: string, credentials: { ca: Buffer; key: Buffer; certificate: Buffer }) {
      this.credentials = credentials;
      admins.push(this);
    }

    ReloadIdentity(
      request: { operationId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) {
      reloadRequests.push(request.operationId ?? '');
      callback(null, { reloaded: true });
    }

    CommitIdentityRotation(
      request: { operationId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) {
      commitRequests.push(request.operationId ?? '');
      if (commitFailures > 0) {
        commitFailures -= 1;
        callback(new Error('commit response lost'));
        return;
      }
      callback(null, { committed: true });
    }

    GetHealth(_request: unknown, _options: unknown, callback: (error: Error | null, value?: unknown) => void) {
      callback(null, { liveness: true });
    }

    GetRouteRuntime(
      request: { routeId?: string },
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) {
      callback(null, { routeId: request.routeId, activeTunnels: '3', openedTotal: '12' });
    }

    close() {
      this.closed = true;
    }
  }
  class TunnelBroker {
    tunnel = new TunnelStream();
    closed = false;

    constructor() {
      brokers.push(this);
    }

    OpenTunnel() {
      return this.tunnel;
    }

    close() {
      this.closed = true;
    }
  }
  return {
    admins,
    brokers,
    reloadRequests,
    commitRequests,
    get commitFailures() {
      return commitFailures;
    },
    set commitFailures(value: number) {
      commitFailures = value;
    },
    RelayAdmin,
    TunnelBroker,
  };
});

vi.mock('@grpc/grpc-js', () => ({
  credentials: {
    createSsl: vi.fn((ca: Buffer, key: Buffer, certificate: Buffer) => ({ ca, key, certificate })),
  },
}));

vi.mock('./relay-proto.js', () => ({
  loadRelayV1Proto: () => ({ RelayAdmin: fakeGrpc.RelayAdmin, TunnelBroker: fakeGrpc.TunnelBroker }),
}));

import { RelayControlClient } from './relay-control.client.js';

describe('RelayControlClient identity rotation', () => {
  let directory: string;
  let caPath: string;
  let certificatePath: string;
  let privateKeyPath: string;

  beforeEach(() => {
    fakeGrpc.admins.length = 0;
    fakeGrpc.brokers.length = 0;
    fakeGrpc.reloadRequests.length = 0;
    fakeGrpc.commitRequests.length = 0;
    fakeGrpc.commitFailures = 0;
    directory = mkdtempSync(join(tmpdir(), 'relay-control-client-'));
    caPath = join(directory, 'ca.crt');
    certificatePath = join(directory, 'client.crt');
    privateKeyPath = join(directory, 'client.key');
    writeFileSync(caPath, 'ca');
    writeFileSync(certificatePath, 'old-certificate');
    writeFileSync(privateKeyPath, 'old-private-key');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('recreates the local gRPC client from changed files after the relay confirms reload', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previous = fakeGrpc.admins[0]!;
    expect(previous.credentials.certificate.toString()).toBe('old-certificate');

    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');

    await expect(client.reloadIdentity()).resolves.toBe(true);
    expect(previous.closed).toBe(true);
    expect(fakeGrpc.admins).toHaveLength(2);
    expect(fakeGrpc.admins[1]!.credentials.certificate.toString()).toBe('new-certificate');
    expect(fakeGrpc.admins[1]!.credentials.key.toString()).toBe('new-private-key');
    expect(fakeGrpc.reloadRequests).toHaveLength(1);
    expect(fakeGrpc.commitRequests).toEqual(fakeGrpc.reloadRequests);
  });

  it('keeps the current clients when relay identity reload is not acknowledged', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previousAdmin = fakeGrpc.admins[0]!;
    const previousBroker = fakeGrpc.brokers[0]!;
    previousAdmin.ReloadIdentity = vi.fn((_request, _options, callback) => callback(new Error('unavailable')));

    writeFileSync(certificatePath, 'new-certificate');
    await expect(client.reloadIdentity()).rejects.toThrow('unavailable');

    expect(fakeGrpc.admins).toHaveLength(2);
    expect(fakeGrpc.brokers).toHaveLength(2);
    expect(previousAdmin.closed).toBe(false);
    expect(previousBroker.closed).toBe(false);
    expect(fakeGrpc.admins[1]!.closed).toBe(false);
    expect(fakeGrpc.brokers[1]!.closed).toBe(false);
  });

  it('retries the same reload operation after an ambiguous lost response', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previousAdmin = fakeGrpc.admins[0]!;
    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');
    let attempts = 0;
    previousAdmin.ReloadIdentity = vi.fn((request, _options, callback) => {
      fakeGrpc.reloadRequests.push(request.operationId ?? '');
      attempts += 1;
      if (attempts === 1) callback(new Error('reload response lost'));
      else callback(null, { reloaded: true });
    });

    await expect(client.reloadIdentity()).rejects.toThrow('reload response lost');
    expect(previousAdmin.closed).toBe(false);

    await expect(client.getHealth()).resolves.toMatchObject({ liveness: true });
    expect(previousAdmin.closed).toBe(true);
    expect(fakeGrpc.reloadRequests).toHaveLength(2);
    expect(new Set(fakeGrpc.reloadRequests).size).toBe(1);
    expect(fakeGrpc.commitRequests).toEqual([fakeGrpc.reloadRequests[0]]);
  });

  it('serializes concurrent reload convergence and installs candidate clients once', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previousAdmin = fakeGrpc.admins[0]!;
    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');
    let acknowledge: ((error: Error | null, value?: unknown) => void) | undefined;
    previousAdmin.ReloadIdentity = vi.fn((request, _options, callback) => {
      fakeGrpc.reloadRequests.push(request.operationId ?? '');
      acknowledge = callback;
    });

    const reload = client.reloadIdentity();
    const health = client.getHealth();
    await vi.waitFor(() => expect(previousAdmin.ReloadIdentity).toHaveBeenCalledOnce());
    acknowledge!(null, { reloaded: true });

    await expect(reload).resolves.toBe(true);
    await expect(health).resolves.toMatchObject({ liveness: true });
    expect(previousAdmin.closed).toBe(true);
    expect(fakeGrpc.reloadRequests).toHaveLength(1);
    expect(fakeGrpc.admins).toHaveLength(2);
    expect(fakeGrpc.admins[1]!.closed).toBe(false);
    expect(fakeGrpc.brokers[1]!.closed).toBe(false);
  });

  it('requests runtime telemetry for one relay route', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });

    await expect(client.getRouteRuntime('route-1')).resolves.toMatchObject({
      routeId: 'route-1',
      activeTunnels: '3',
      openedTotal: '12',
    });
  });

  it('retries an explicit rotation commit after its response is lost', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');
    fakeGrpc.commitFailures = 1;

    await expect(client.reloadIdentity()).resolves.toBe(true);
    expect(fakeGrpc.commitRequests).toEqual(fakeGrpc.reloadRequests);

    await expect(client.getHealth()).resolves.toMatchObject({ liveness: true });
    expect(fakeGrpc.commitRequests).toEqual([fakeGrpc.reloadRequests[0], fakeGrpc.reloadRequests[0]]);
  });

  it('pauses relay responses until a stalled local reader asks for more data', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const tunnel = fakeGrpc.brokers[0]!.tunnel;
    const opening = client.openTunnel({ keyId: 'key-1', payload: Buffer.from('{}'), signature: Buffer.alloc(64) });
    tunnel.emit('data', { ready: { maxFrameBytes: 1024 * 1024 } });
    const driver = await opening;

    tunnel.emit('data', { data: { data: Buffer.alloc(1024 * 1024) } });
    expect(tunnel.pause).toHaveBeenCalledOnce();
    expect(tunnel.resume).not.toHaveBeenCalled();

    const received = once(driver, 'data');
    driver.resume();
    await received;
    expect(tunnel.resume).toHaveBeenCalledOnce();
    driver.destroy();
  });
});
