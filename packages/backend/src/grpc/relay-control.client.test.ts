import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testKeys = forge.pki.rsa.generateKeyPair(1024);
let testSerial = 1;

function selfSignedPem(commonName: string): string {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = testKeys.publicKey;
  certificate.serialNumber = (testSerial++).toString(16).padStart(2, '0');
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: 'commonName', value: commonName }]);
  certificate.setIssuer([{ name: 'commonName', value: commonName }]);
  certificate.sign(testKeys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

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
  const brokers: Array<{
    tunnel: TunnelStream;
    closed: boolean;
    credentials?: { ca: Buffer; key: Buffer; certificate: Buffer };
  }> = [];
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
    credentials?: { ca: Buffer; key: Buffer; certificate: Buffer };

    constructor(_target?: string, credentials?: { ca: Buffer; key: Buffer; certificate: Buffer }) {
      this.credentials = credentials;
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
  status: { PERMISSION_DENIED: 7, UNAUTHENTICATED: 16 },
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

  it('asks the relay to reload with the client it still trusts after Gateway renewed its own', async () => {
    const previousCertificatePath = join(directory, 'client.previous.crt');
    const previousPrivateKeyPath = join(directory, 'client.previous.key');
    writeFileSync(previousCertificatePath, 'previous-certificate');
    writeFileSync(previousPrivateKeyPath, 'previous-private-key');
    writeFileSync(certificatePath, 'renewed-certificate');
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
      previousCertificatePath,
      previousPrivateKeyPath,
    });
    const [previous, renewed] = fakeGrpc.admins;
    expect(previous!.credentials.certificate.toString()).toBe('previous-certificate');
    expect(renewed!.credentials.certificate.toString()).toBe('renewed-certificate');

    await client.getHealth();
    // The previous client asked for the reload and the renewed one committed it.
    expect(fakeGrpc.reloadRequests).toHaveLength(1);
    expect(fakeGrpc.commitRequests).toEqual(fakeGrpc.reloadRequests);
    expect(previous!.closed).toBe(true);
  });

  it('moves to the renewed client when the relay already trusts only that one', async () => {
    const previousCertificatePath = join(directory, 'client.previous.crt');
    const previousPrivateKeyPath = join(directory, 'client.previous.key');
    writeFileSync(previousCertificatePath, 'previous-certificate');
    writeFileSync(previousPrivateKeyPath, 'previous-private-key');
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
      previousCertificatePath,
      previousPrivateKeyPath,
    });
    const [previous, renewed] = fakeGrpc.admins;
    previous!.ReloadIdentity = vi.fn((_request, _options, callback) =>
      callback(Object.assign(new Error('7 PERMISSION_DENIED: Gateway app service certificate required'), { code: 7 }))
    );

    await expect(client.getHealth()).resolves.toMatchObject({ liveness: true });
    expect(previous!.closed).toBe(true);
    expect(renewed!.closed).toBe(false);
    expect(fakeGrpc.commitRequests).toEqual([]);
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

  it('re-targets an unconfirmed reload at the client identity a later renewal installed', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previousAdmin = fakeGrpc.admins[0]!;
    let available = false;
    previousAdmin.ReloadIdentity = vi.fn((request, _options, callback) => {
      if (!available) {
        callback(new Error('unavailable'));
        return;
      }
      fakeGrpc.reloadRequests.push(request.operationId ?? '');
      callback(null, { reloaded: true });
    });

    writeFileSync(certificatePath, 'renewed-once');
    await expect(client.reloadIdentity()).rejects.toThrow('unavailable');
    const stale = fakeGrpc.admins[1]!;

    writeFileSync(certificatePath, 'renewed-twice');
    available = true;
    await expect(client.reloadIdentity()).resolves.toBe(true);

    expect(stale.closed).toBe(true);
    const current = fakeGrpc.admins[2]!;
    expect(current.credentials.certificate.toString()).toBe('renewed-twice');
    expect(current.closed).toBe(false);
    expect(fakeGrpc.commitRequests).toEqual(fakeGrpc.reloadRequests);
  });

  it('reports the client identity it moved to and presents it to remote relay candidates', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const activated = vi.fn();
    client.setIdentityActivationListener(activated);
    const candidate = {
      relayInstanceId: 'relay-1',
      addresses: ['192.0.2.10'],
      port: 9443,
      certificateIdentity: 'relay-relay-1',
      certificateFingerprint: 'sha256:00',
      grant: { keyId: 'key-1', payload: Buffer.from('{}'), signature: Buffer.alloc(64) },
    };
    const candidateCertificate = () => {
      void client.openCandidateTunnel(candidate as never, 10).catch(() => undefined);
      return fakeGrpc.brokers.at(-1)!.credentials!.certificate.toString();
    };

    // Renewed files are installed, but the relay has not confirmed them: keep presenting the old client.
    writeFileSync(certificatePath, 'new-certificate');
    writeFileSync(privateKeyPath, 'new-private-key');
    expect(candidateCertificate()).toBe('old-certificate');

    await expect(client.reloadIdentity()).resolves.toBe(true);
    expect(activated).toHaveBeenCalledWith({
      certificate: Buffer.from('new-certificate'),
      certificateSha256: null,
      loaded: null,
    });
    expect(candidateCertificate()).toBe('new-certificate');
  });

  it('waits for a reload already in flight and sends a fresh one for files written since', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const previousAdmin = fakeGrpc.admins[0]!;
    let answer: ((error: Error | null, value?: unknown) => void) | undefined;
    previousAdmin.ReloadIdentity = vi.fn((request, _options, callback) => {
      fakeGrpc.reloadRequests.push(request.operationId ?? '');
      answer = callback;
    });

    writeFileSync(certificatePath, 'renewed-once');
    const inFlight = client.reloadIdentity();
    await vi.waitFor(() => expect(previousAdmin.ReloadIdentity).toHaveBeenCalledOnce());
    // A renewal writes new files while the relay still answers the earlier reload.
    writeFileSync(certificatePath, 'renewed-twice');
    const reload = client.reloadIdentity();
    answer!(null, { reloaded: true });

    await expect(inFlight).resolves.toBe(true);
    await expect(reload).resolves.toBe(true);
    expect(fakeGrpc.reloadRequests).toHaveLength(2);
    expect(new Set(fakeGrpc.reloadRequests).size).toBe(2);
    expect(fakeGrpc.admins.at(-1)!.credentials.certificate.toString()).toBe('renewed-twice');
    expect(fakeGrpc.admins.at(-1)!.closed).toBe(false);
  });

  it('stays on its current client when the relay loaded a different one, and reports what it loaded', async () => {
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
    });
    const activated = vi.fn();
    client.setIdentityActivationListener(activated);
    const previousAdmin = fakeGrpc.admins[0]!;
    const renewed = selfSignedPem('app-relay-client');
    writeFileSync(certificatePath, renewed);
    const renewedSha256 = `sha256:${createHash('sha256').update(new X509Certificate(renewed).raw).digest('hex')}`;
    const loaded = {
      externalCertificateSha256: 'sha256:external',
      relayClientCertificateSha256: 'sha256:relay-client',
      appClientCertificateSha256: 'sha256:another-client',
    };
    previousAdmin.ReloadIdentity = vi.fn((_request, _options, callback) =>
      callback(null, { reloaded: true, ...loaded })
    );

    await expect(client.reloadIdentity()).resolves.toBe(false);
    expect(activated).not.toHaveBeenCalled();
    expect(previousAdmin.closed).toBe(false);
    expect(client.activeClientCertificateSha256()).toBeNull(); // still the old, non-PEM test client

    previousAdmin.ReloadIdentity = vi.fn((_request, _options, callback) =>
      callback(null, { reloaded: true, ...loaded, appClientCertificateSha256: renewedSha256 })
    );
    await expect(client.reloadIdentity()).resolves.toBe(true);
    expect(activated).toHaveBeenCalledWith({
      certificate: Buffer.from(renewed),
      certificateSha256: renewedSha256,
      loaded: { ...loaded, appClientCertificateSha256: renewedSha256 },
    });
    expect(client.activeClientCertificateSha256()).toBe(renewedSha256);
  });

  it('starts on the previous client after a restart, the one Gateway grants name until the relay confirms', () => {
    const previousPem = selfSignedPem('app-relay-client-previous');
    const previousCertificatePath = join(directory, 'client.previous.crt');
    const previousPrivateKeyPath = join(directory, 'client.previous.key');
    writeFileSync(previousCertificatePath, previousPem);
    writeFileSync(previousPrivateKeyPath, 'previous-private-key');
    writeFileSync(certificatePath, selfSignedPem('app-relay-client'));
    const client = new RelayControlClient({
      target: 'relay:9443',
      systemCaPath: caPath,
      certificatePath,
      privateKeyPath,
      previousCertificatePath,
      previousPrivateKeyPath,
    });

    expect(client.activeClientCertificateSha256()).toBe(
      `sha256:${createHash('sha256').update(new X509Certificate(previousPem).raw).digest('hex')}`
    );
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
