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
  const instances: Array<{
    credentials: { ca: Buffer; key: Buffer; certificate: Buffer };
    closed: boolean;
    tunnel: TunnelStream;
    ReloadIdentity: (
      _request: unknown,
      _options: unknown,
      callback: (error: Error | null, value?: unknown) => void
    ) => void;
    OpenManagedDatabaseTunnel: () => TunnelStream;
    close: () => void;
  }> = [];
  class GatewayRelayControl {
    credentials: { ca: Buffer; key: Buffer; certificate: Buffer };
    closed = false;
    tunnel = new TunnelStream();

    constructor(_target: string, credentials: { ca: Buffer; key: Buffer; certificate: Buffer }) {
      this.credentials = credentials;
      instances.push(this);
    }

    ReloadIdentity(_request: unknown, _options: unknown, callback: (error: Error | null, value?: unknown) => void) {
      callback(null, { reloaded: true });
    }

    OpenManagedDatabaseTunnel() {
      return this.tunnel;
    }

    close() {
      this.closed = true;
    }
  }
  return { instances, GatewayRelayControl };
});

vi.mock('@grpc/grpc-js', () => ({
  credentials: {
    createSsl: vi.fn((ca: Buffer, key: Buffer, certificate: Buffer) => ({ ca, key, certificate })),
  },
}));

vi.mock('@/relay/proto.js', () => ({
  loadRelayProto: () => ({ GatewayRelayControl: fakeGrpc.GatewayRelayControl }),
}));

import { RelayControlClient } from './relay-control.client.js';

describe('RelayControlClient identity rotation', () => {
  let directory: string;
  let caPath: string;
  let certificatePath: string;
  let privateKeyPath: string;

  beforeEach(() => {
    fakeGrpc.instances.length = 0;
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
    const previous = fakeGrpc.instances[0]!;
    expect(previous.credentials.certificate.toString()).toBe('old-certificate');

    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');

    await expect(client.reloadIdentity()).resolves.toBe(true);
    expect(previous.closed).toBe(true);
    expect(fakeGrpc.instances).toHaveLength(2);
    expect(fakeGrpc.instances[1]!.credentials.certificate.toString()).toBe('new-certificate');
    expect(fakeGrpc.instances[1]!.credentials.key.toString()).toBe('new-private-key');
  });

  it('pauses relay responses until a stalled local reader asks for more data', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const tunnel = fakeGrpc.instances[0]!.tunnel;
    const opening = client.openManagedDatabaseTunnel('33333333-3333-4333-8333-333333333333');
    tunnel.emit('data', { ready: { maxChunkBytes: 1024 * 1024 } });
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
