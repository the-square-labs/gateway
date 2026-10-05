import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { Duplex } from 'node:stream';
import type { PeerCertificate } from 'node:tls';
import * as grpc from '@grpc/grpc-js';
import type { AvailabilityLeaseReport } from './generated/types.js';
import { decodeRelayV1Message, loadRelayV1Proto } from './relay-proto.js';
import {
  type AttachablePath,
  type PathEnd,
  type RelayResumeRegistry,
  type RelayResumeStatsSnapshot,
  ResumableRelayDuplex,
  type ResumeDialer,
  type ResumePathSink,
  relayResumeRegistry,
} from './relay-resume.js';

export const RELAY_MAX_FRAME_BYTES = 1024 * 1024;

export interface SignedRelayGrant {
  keyId: string;
  payload: Buffer;
  signature: Buffer;
}

export interface RelayTunnelCandidate {
  addresses: string[];
  port: number;
  certificateIdentity: string;
  certificateFingerprint: string;
  grant: SignedRelayGrant;
}

export interface RelayPolicySnapshot {
  revision: string;
  gatewayInstanceId: string;
  publicKeys: Array<{ keyId: string; publicKey: Buffer }>;
  endpoints: Array<{
    endpointId: string;
    generation: string;
    subjectKind: string;
    subjectId: string;
    certificateSha256: string;
    maxConcurrentSessions: number;
  }>;
  routes: Array<{
    routeId: string;
    generation: string;
    sourceKind: string;
    sourceId: string;
    sourceCertificateSha256: string;
    targetEndpointId: string;
    maxConcurrentSessions: number;
    maxFrameBytes: number;
    disableIdleTimeout: boolean;
    trafficClass: 'proxy' | 'database' | 'registry';
  }>;
  admissionPolicy: {
    enabled: boolean;
    proxyTargetPressurePercent: number;
    databaseReservePercent: number;
    hardPressurePercent: number;
  };
}

interface RelayTunnelMessage {
  open?: { grant: SignedRelayGrant };
  ready?: { maxFrameBytes: number };
  data?: { data: Buffer | Uint8Array };
  halfClose?: Record<string, never>;
  close?: Record<string, never>;
  error?: { code: string; message: string };
}

class RelayTunnelDuplex extends Duplex {
  private tunnelClosed = false;
  private inboundPaused = false;

  constructor(
    private readonly stream: grpc.ClientDuplexStream<RelayTunnelMessage, RelayTunnelMessage>,
    private readonly maxFrameBytes: number
  ) {
    super();
    stream.on('data', (message) => {
      if (message.data) {
        if (!this.push(Buffer.from(message.data.data))) {
          this.inboundPaused = true;
          stream.pause();
        }
      } else if (message.error) this.destroy(new Error(message.error.message.slice(0, 256)));
      else if (message.close || message.halfClose) this.push(null);
    });
    stream.once('end', () => this.push(null));
    stream.once('error', (error) => this.destroy(error));
  }

  _read(): void {
    if (!this.inboundPaused) return;
    this.inboundPaused = false;
    this.stream.resume();
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (chunk.byteLength <= 0 || chunk.byteLength > this.maxFrameBytes) {
      callback(new Error('Relay frame exceeds the negotiated limit'));
      return;
    }
    try {
      if (this.stream.write({ data: { data: Buffer.from(chunk) } })) callback();
      else this.stream.once('drain', callback);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Relay write failed'));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    if (!this.tunnelClosed) this.stream.write({ halfClose: {} });
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.tunnelClosed) {
      this.tunnelClosed = true;
      try {
        this.stream.write({ close: {} });
        this.stream.end();
      } catch {
        this.stream.cancel();
      }
    }
    callback(error);
  }
}

/** Pre-pool assignments without candidates: the path relay id both ends use. */
export const LEGACY_RELAY_PATH_ID = 'local';

type RelayTunnelStream = grpc.ClientDuplexStream<RelayTunnelMessage, RelayTunnelMessage>;

/** A grpc status that keeps today's terminal semantics instead of starting a resume. */
function isTerminalTunnelStatus(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  // The relay's verdicts on the stream itself (as relayresume): its idle and half-close timeouts, refused frames.
  if (code === grpc.status.DEADLINE_EXCEEDED) return /idle timeout|half-close timeout/i.test(message);
  return code === grpc.status.INVALID_ARGUMENT;
}

/**
 * One relay tunnel stream after Ready, carrying RSv1 records for a ResumableRelayDuplex. Events wait in a queue until
 * the session attaches. The relay's idle timeout ends the path terminally (as relayresume does); any other end (GOAWAY
 * cut, relay restart, force-disconnect, a frame ending the path, transport failure) lets the session resume elsewhere.
 */
class RelayResumePath implements AttachablePath {
  private sink: ResumePathSink | null = null;
  private readonly backlog: Array<(sink: ResumePathSink) => void> = [];
  private ended = false;
  private drainWaiting = false;
  private laneWatched = false;

  constructor(
    private readonly stream: RelayTunnelStream,
    readonly maxFrameBytes: number,
    readonly relayId: string,
    private readonly channel: grpc.Channel | null,
    private readonly dispose: () => void
  ) {
    stream.on('data', (message: RelayTunnelMessage) => {
      if (message.data) {
        const frame = Buffer.from(message.data.data);
        this.emit((sink) => sink.frame(frame));
      } else if (message.error) {
        // Before HELLO_ACK the session cuts on any path end; after it, the target's error ends only this path.
        this.finish({ error: new Error(message.error.message.slice(0, 256)) });
      } else if (message.close || message.halfClose) {
        // The target ends a path it gave up (after a RESUME elsewhere) with a half-close: this path is over.
        this.finish({});
      }
    });
    stream.once('end', () => this.finish({}));
    stream.on('error', (error) => this.finish({ error, terminal: isTerminalTunnelStatus(error) }));
    stream.on('drain', () => {
      if (!this.drainWaiting) return;
      this.drainWaiting = false;
      this.emit((sink) => sink.drained());
    });
  }

  attach(sink: ResumePathSink): void {
    this.sink = sink;
    for (const event of this.backlog.splice(0)) event(sink);
    this.watchLane();
  }

  send(frame: Buffer): boolean {
    if (this.ended) return true;
    try {
      if (this.stream.write({ data: { data: frame } })) return true;
      this.drainWaiting = true;
      return false;
    } catch {
      return true;
    }
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.stream.write({ close: {} });
      this.stream.end();
    } catch {
      this.stream.cancel();
    }
    // The relay ends the stream after Close; do not hold the channel for a slow peer.
    const timer = setTimeout(() => {
      this.stream.cancel();
      this.dispose();
    }, 10_000);
    timer.unref?.();
    this.stream.once('close', () => {
      clearTimeout(timer);
      this.dispose();
    });
  }

  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.stream.cancel();
    this.dispose();
  }

  private emit(event: (sink: ResumePathSink) => void): void {
    if (this.sink) event(this.sink);
    else this.backlog.push(event);
  }

  private finish(end: PathEnd): void {
    if (this.ended) {
      this.dispose();
      return;
    }
    this.ended = true;
    // A path that ended by a relay frame (Close, HalfClose, Error) is still an open call: end it, or the relay
    // keeps the tunnel (and its session capacity) until the whole stream ends.
    this.stream.cancel();
    this.dispose();
    this.emit((sink) => sink.ended(end));
  }

  /** GOAWAY leaves the channel not READY while this stream still runs: the session moves at once. */
  private watchLane(): void {
    const channel = this.channel;
    if (!channel || this.laneWatched) return;
    this.laneWatched = true;
    const watch = (state: grpc.connectivityState) => {
      if (this.ended) return;
      channel.watchConnectivityState(state, Date.now() + 10 * 60_000, (error) => {
        if (this.ended) return;
        const next = channel.getConnectivityState(false);
        if (!error && next !== grpc.connectivityState.READY && state === grpc.connectivityState.READY) {
          this.emit((sink) => sink.laneLost());
        }
        watch(next);
      });
    };
    try {
      watch(channel.getConnectivityState(false));
    } catch {
      // A closed channel has no state to watch.
    }
  }
}

export interface RelayResumeConfig {
  routeId: string;
  keyId: string;
  key: Buffer;
  halfCloseTimeoutMs?: number;
}

export interface RelayHealthResponse {
  buildVersion: string;
  protocolMajor: number;
  appliedRevision: string;
  keyIds: string[];
  registeredEndpoints: string;
  activeTunnels: string;
  liveness: boolean;
  readiness: boolean;
  reason: string;
  activeProxyTunnels?: string;
  activeDatabaseTunnels?: string;
  throttledProxyTotal?: string;
  throttledDatabaseTotal?: string;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  memoryRssBytes?: string;
  heapInUseBytes?: string;
  memoryLimitBytes?: string;
  openFileDescriptors?: string;
  fileDescriptorLimit?: string;
  poolId?: string;
  relayInstanceId?: string;
  capabilities?: string[];
  policyExpiresAtUnix?: string;
  draining?: boolean;
  assignmentTunnels?: Array<{ endpointId: string; assignmentGeneration: string; activeTunnels: string }>;
  policyKeyIds?: string[];
  /**
   * Acceptor and data-path gate view of a relay advertising availability_lease_v1, in the shape of gateway.v1
   * AvailabilityLeaseReport (member_id is the relay instance id).
   */
  availabilityLease?: AvailabilityLeaseReport | null;
}

export interface RelayRouteRuntimeResponse {
  routeId: string;
  activeTunnels: string;
  openedTotal: string;
  completedTotal: string;
  failedTotal: string;
  throttledTotal: string;
  sourceToTargetBytes: string;
  targetToSourceBytes: string;
  setupLatencyP95Microseconds: string;
  averageDurationMilliseconds: string;
  lastActivityUnixMilliseconds: string;
  metricsSinceUnixMilliseconds: string;
}

export interface RelayControlClientOptions {
  target: string;
  systemCaPath: string;
  certificatePath: string;
  privateKeyPath: string;
  /**
   * The client certificate the running relay may still trust after Gateway renewed its own at
   * start-up. The relay reloads its identity only when a client it trusts asks, so the first
   * admin call uses this one and then moves to the renewed certificate.
   */
  previousCertificatePath?: string;
  previousPrivateKeyPath?: string;
}

/** The relay refused the caller's client certificate, as opposed to being unreachable. */
function isClientIdentityRefusal(error: unknown): boolean {
  const code = (error as { code?: number } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return (
    code === grpc.status.PERMISSION_DENIED ||
    code === grpc.status.UNAUTHENTICATED ||
    /certificate|handshake|ssl|tls/i.test(message)
  );
}

interface ClientIdentity {
  privateKey: Buffer;
  certificate: Buffer;
}

/** What a relay reports it loaded on ReloadIdentity; relays built before the report send none. */
export interface RelayLoadedIdentity {
  externalCertificateSha256: string;
  relayClientCertificateSha256: string;
  appClientCertificateSha256: string;
}

/** The client identity Gateway moved to after the relay confirmed a reload. */
export interface RelayIdentityActivation {
  /** The client certificate Gateway presents to relays from now on. */
  certificate: Buffer;
  /** Its fingerprint, "sha256:<hex>", or null when it does not parse. */
  certificateSha256: string | null;
  /** What the relay loaded, when it said so; null for older relays and for a relay that restarted. */
  loaded: RelayLoadedIdentity | null;
}

function certificateSha256(certificatePem: Buffer): string | null {
  try {
    return `sha256:${createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex')}`;
  } catch {
    return null;
  }
}

function loadedIdentity(response: {
  externalCertificateSha256?: string;
  relayClientCertificateSha256?: string;
  appClientCertificateSha256?: string;
}): RelayLoadedIdentity | null {
  const loaded = {
    externalCertificateSha256: response.externalCertificateSha256 ?? '',
    relayClientCertificateSha256: response.relayClientCertificateSha256 ?? '',
    appClientCertificateSha256: response.appClientCertificateSha256 ?? '',
  };
  return Object.values(loaded).some(Boolean) ? loaded : null;
}

export class RelayControlClient {
  readonly resumeRegistry: RelayResumeRegistry = relayResumeRegistry;
  private admin: any;
  private broker: any;
  private pendingIdentityReload?: { operationId: string; admin: any; broker: any; identity: ClientIdentity };
  /** The client identity the current admin and broker clients present. */
  private activeIdentity: ClientIdentity;
  private identityActivationListener?: (activation: RelayIdentityActivation) => void;
  private identityReloadConvergence?: Promise<boolean>;
  private pendingIdentityCommit?: string;

  constructor(private readonly options: RelayControlClientOptions) {
    const previous = this.readPreviousIdentity();
    if (previous) {
      ({ admin: this.admin, broker: this.broker, identity: this.activeIdentity } = this.createClients(previous));
      this.pendingIdentityReload = { operationId: randomUUID(), ...this.createClients() };
    } else {
      ({ admin: this.admin, broker: this.broker, identity: this.activeIdentity } = this.createClients());
    }
  }

  private readPreviousIdentity(): { certificatePath: string; privateKeyPath: string } | null {
    const { previousCertificatePath, previousPrivateKeyPath } = this.options;
    if (!previousCertificatePath || !previousPrivateKeyPath) return null;
    if (!existsSync(previousCertificatePath) || !existsSync(previousPrivateKeyPath)) return null;
    return { certificatePath: previousCertificatePath, privateKeyPath: previousPrivateKeyPath };
  }

  private createClients(identity?: { certificatePath: string; privateKeyPath: string }): {
    admin: any;
    broker: any;
    identity: ClientIdentity;
  } {
    const relayV1 = loadRelayV1Proto();
    const material = {
      privateKey: readFileSync(identity?.privateKeyPath ?? this.options.privateKeyPath),
      certificate: readFileSync(identity?.certificatePath ?? this.options.certificatePath),
    };
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.options.systemCaPath),
      material.privateKey,
      material.certificate
    );
    const options = {
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
      // The local relay is one hop away: after its restart reconnect within seconds, not after
      // grpc-js's default backoff of up to 120 s during which every admin call fails.
      'grpc.initial_reconnect_backoff_ms': 500,
      'grpc.max_reconnect_backoff_ms': 5_000,
    };
    return {
      admin: new relayV1.RelayAdmin(this.options.target, credentials, options),
      broker: new relayV1.TunnelBroker(this.options.target, credentials, options),
      identity: material,
    };
  }

  /**
   * Called whenever the relay confirmed a reload and Gateway moved to the client identity on
   * disk, including a reload a later admin call converged.
   */
  setIdentityActivationListener(listener: (activation: RelayIdentityActivation) => void): void {
    this.identityActivationListener = listener;
  }

  /** Fingerprint of the client certificate Gateway presents to relays now; grants must name it. */
  activeClientCertificateSha256(): string | null {
    return certificateSha256(this.activeIdentity.certificate);
  }

  private adoptPendingIdentity(
    pending: NonNullable<RelayControlClient['pendingIdentityReload']>,
    loaded: RelayLoadedIdentity | null
  ): void {
    const previousAdmin = this.admin;
    const previousBroker = this.broker;
    this.admin = pending.admin;
    this.broker = pending.broker;
    this.activeIdentity = pending.identity;
    if (this.pendingIdentityReload === pending) this.pendingIdentityReload = undefined;
    // Closing a channel ends no call already running on it.
    previousAdmin.close();
    previousBroker.close();
    try {
      this.identityActivationListener?.({
        certificate: pending.identity.certificate,
        certificateSha256: certificateSha256(pending.identity.certificate),
        loaded,
      });
    } catch {
      // A listener failure must not undo a reload the relay already confirmed.
    }
  }

  close(): void {
    this.admin.close();
    this.broker.close();
    this.pendingIdentityReload?.admin.close();
    this.pendingIdentityReload?.broker.close();
    this.pendingIdentityReload = undefined;
  }

  async getHealth(timeoutMs = 2_000): Promise<RelayHealthResponse> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('GetHealth', {}, timeoutMs) as Promise<RelayHealthResponse>;
  }

  async getRouteRuntime(routeId: string, timeoutMs = 2_000): Promise<RelayRouteRuntimeResponse> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('GetRouteRuntime', { routeId }, timeoutMs) as Promise<RelayRouteRuntimeResponse>;
  }

  async applySnapshot(
    snapshot: RelayPolicySnapshot,
    timeoutMs = 5_000
  ): Promise<{ appliedRevision: string; unchanged: boolean }> {
    await this.convergePendingIdentityReload(timeoutMs).catch(() => undefined);
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return this.unary('ApplySnapshot', snapshot, timeoutMs) as Promise<{ appliedRevision: string; unchanged: boolean }>;
  }

  async applyEncodedSnapshot(
    encoded: Buffer,
    timeoutMs = 5_000
  ): Promise<{ appliedRevision: string; unchanged: boolean }> {
    const request = decodeRelayV1Message('ApplySnapshotRequest', encoded);
    return this.unary('ApplySnapshot', request, timeoutMs) as Promise<{ appliedRevision: string; unchanged: boolean }>;
  }

  async bootstrapPolicyTrust(
    keyId: string,
    publicKey: Buffer,
    publicKeyFingerprint: string,
    timeoutMs = 5_000
  ): Promise<void> {
    await this.unary('BootstrapPolicyTrust', { keyId, publicKey, publicKeyFingerprint }, timeoutMs);
  }

  /** Local combined relay only: replaces its pinned policy trust with one key. Remote relays refuse it. */
  async resetLocalPolicyTrust(
    keyId: string,
    publicKey: Buffer,
    publicKeyFingerprint: string,
    timeoutMs = 5_000
  ): Promise<{ replacedKeyIds: string[] }> {
    const response = (await this.unary(
      'ResetLocalPolicyTrust',
      { keyId, publicKey, publicKeyFingerprint },
      timeoutMs
    )) as { replacedKeyIds?: string[] };
    return { replacedKeyIds: response.replacedKeyIds ?? [] };
  }

  /** Stops (or resumes) admitting new tunnels; `forceDisconnect` also closes the open ones of a draining relay. */
  async setDrain(draining: boolean, forceDisconnect = false, timeoutMs = 5_000): Promise<void> {
    await this.unary('SetDrain', { draining, operationId: randomUUID(), forceDisconnect }, timeoutMs);
  }

  /**
   * Asks the relay to load the identity files installed now and moves to the client on disk.
   * A reload already in flight may have been answered before those files were written, so it is
   * awaited and a fresh one is always sent.
   */
  async reloadIdentity(timeoutMs = 2_000): Promise<boolean> {
    while (this.identityReloadConvergence) {
      await this.identityReloadConvergence.catch(() => undefined);
    }
    // Target the client identity on disk now. A reload staged earlier and never confirmed
    // may name a certificate that a later renewal already replaced.
    const stale = this.pendingIdentityReload;
    this.pendingIdentityReload = { operationId: randomUUID(), ...this.createClients() };
    stale?.admin.close();
    stale?.broker.close();
    return this.convergePendingIdentityReload(timeoutMs);
  }

  private async convergePendingIdentityReload(timeoutMs: number): Promise<boolean> {
    if (!this.pendingIdentityReload) return true;
    if (this.identityReloadConvergence) return this.identityReloadConvergence;
    const convergence = this.performIdentityReloadConvergence(timeoutMs);
    this.identityReloadConvergence = convergence;
    try {
      return await convergence;
    } finally {
      if (this.identityReloadConvergence === convergence) this.identityReloadConvergence = undefined;
    }
  }

  private async performIdentityReloadConvergence(timeoutMs: number): Promise<boolean> {
    const pending = this.pendingIdentityReload;
    if (!pending) return true;
    let result: { reloaded?: boolean } & Parameters<typeof loadedIdentity>[0];
    try {
      result = (await this.unary('ReloadIdentity', { operationId: pending.operationId }, timeoutMs)) as typeof result;
    } catch (error) {
      // The relay no longer trusts the current client: it already loaded the renewed identity
      // (it restarted, or another Gateway process reloaded it). Move to the renewed client
      // once the relay accepts it; there is no rotation left to commit.
      if (!isClientIdentityRefusal(error)) throw error;
      await this.unaryWith(pending.admin, 'GetHealth', {}, timeoutMs);
      this.adoptPendingIdentity(pending, null);
      return true;
    }
    const loaded = loadedIdentity(result);
    const pendingSha256 = certificateSha256(pending.identity.certificate);
    // The relay loaded files written after this client was staged: it trusts another client, so
    // stay on the current one (the relay keeps trusting it) until a fresh reload targets them.
    const loadedOtherClient =
      loaded !== null && pendingSha256 !== null && loaded.appClientCertificateSha256 !== pendingSha256;
    if (result.reloaded !== true || loadedOtherClient) {
      pending.admin.close();
      pending.broker.close();
      if (this.pendingIdentityReload === pending) this.pendingIdentityReload = undefined;
      return false;
    }
    this.adoptPendingIdentity(pending, loaded);
    this.pendingIdentityCommit = pending.operationId;
    // Commit is explicitly operation-bound and uses the candidate identity.
    // A lost response is safe and retried by later admin operations.
    await this.flushPendingIdentityCommit(timeoutMs).catch(() => undefined);
    return true;
  }

  openTunnel(grant: SignedRelayGrant, timeoutMs = 5_000): Promise<Duplex> {
    return this.openTunnelWithBroker(this.broker, grant, timeoutMs);
  }

  async openCandidateTunnel(candidate: RelayTunnelCandidate, timeoutMs = 5_000): Promise<Duplex> {
    if (!candidate.addresses.length) throw new Error('Relay candidate has no advertised address');
    if (!candidate.certificateIdentity || !candidate.certificateFingerprint) {
      throw new Error('Relay candidate identity is incomplete');
    }
    const startedAt = Date.now();
    let lastError: unknown;
    for (const address of candidate.addresses) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      const broker = this.createCandidateBroker(address, candidate);
      try {
        const tunnel = await this.openTunnelWithBroker(broker, candidate.grant, remainingMs);
        tunnel.once('close', () => broker.close());
        return tunnel;
      } catch (error) {
        lastError = error;
        broker.close();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Relay candidate is unavailable');
  }

  /**
   * Opens one relay path for a resumable stream through the local relay (`relayId` is the candidate's relay instance
   * id, or LEGACY_RELAY_PATH_ID for a pre-pool assignment).
   */
  openLocalResumePath(grant: SignedRelayGrant, relayId: string, timeoutMs = 5_000): Promise<AttachablePath> {
    const broker = this.broker;
    return this.openStreamWithBroker(broker, grant, timeoutMs, (stream, maxFrameBytes) => {
      return new RelayResumePath(stream, maxFrameBytes, relayId, channelOf(broker), () => undefined);
    });
  }

  /** Opens one relay path for a resumable stream through a pool candidate, trying its addresses in order. */
  async openCandidateResumePath(
    candidate: RelayTunnelCandidate & { relayInstanceId: string },
    timeoutMs = 5_000
  ): Promise<AttachablePath> {
    if (!candidate.addresses.length) throw new Error('Relay candidate has no advertised address');
    if (!candidate.certificateIdentity || !candidate.certificateFingerprint) {
      throw new Error('Relay candidate identity is incomplete');
    }
    const startedAt = Date.now();
    let lastError: unknown;
    for (const address of candidate.addresses) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      const broker = this.createCandidateBroker(address, candidate);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        broker.close();
      };
      try {
        return await this.openStreamWithBroker(broker, candidate.grant, remainingMs, (stream, maxFrameBytes) => {
          return new RelayResumePath(stream, maxFrameBytes, candidate.relayInstanceId, channelOf(broker), dispose);
        });
      } catch (error) {
        lastError = error;
        dispose();
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Relay candidate is unavailable');
  }

  /**
   * Opens a resumable (RSv1) stream: the first path through `dial`, then HELLO. Rejects with a ResumeSessionError
   * of code 'legacy_peer' when the target is not resume-aware; the route is then latched legacy for a while
   * (isResumeLegacy) and the caller opens a raw tunnel.
   */
  openResumableTunnel(config: RelayResumeConfig, dial: ResumeDialer): Promise<Duplex> {
    return ResumableRelayDuplex.open({ ...config, dial, registry: this.resumeRegistry });
  }

  /** The route's target answered a HELLO with something else within the latch time: use raw streams. */
  isResumeLegacy(routeId: string): boolean {
    return this.resumeRegistry.isLegacy(routeId);
  }

  /**
   * Moves Gateway's resumable streams off a draining relay, spread until the deadline (unix ms; 0 or absent: over a
   * minute). Returns how many streams are affected.
   */
  migrateResumableTunnels(relayInstanceId: string, deadlineUnixMs = 0): number {
    return this.resumeRegistry.drainRelay(relayInstanceId, deadlineUnixMs);
  }

  /** Telemetry for Gateway's own relayed streams. */
  relayResumeStats(): RelayResumeStatsSnapshot {
    return this.resumeRegistry.snapshot();
  }

  /** Counts a raw (legacy) Gateway stream for telemetry while it is open. */
  trackLegacyTunnel(tunnel: Duplex, relayInstanceId = LEGACY_RELAY_PATH_ID): Duplex {
    this.resumeRegistry.countLegacy(1, relayInstanceId);
    tunnel.once('close', () => this.resumeRegistry.countLegacy(-1, relayInstanceId));
    return tunnel;
  }

  async probeCandidate(candidate: RelayTunnelCandidate, timeoutMs = 5_000): Promise<void> {
    const tunnel = await this.openCandidateTunnel(candidate, timeoutMs);
    tunnel.destroy();
  }

  private createCandidateBroker(address: string, candidate: RelayTunnelCandidate): any {
    const relayV1 = loadRelayV1Proto();
    const expectedFingerprint = normalizeCertificateFingerprint(candidate.certificateFingerprint);
    // Present the identity the local clients present, which Gateway's tunnel grants name: until
    // the local relay confirmed a renewal it is the previous one, even with renewed files installed.
    const credentials = grpc.credentials.createSsl(
      readFileSync(this.options.systemCaPath),
      this.activeIdentity.privateKey,
      this.activeIdentity.certificate,
      {
        checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => {
          const actual = normalizeCertificateFingerprint(certificate.fingerprint256 ?? '');
          return actual === expectedFingerprint
            ? undefined
            : new Error('Relay candidate certificate fingerprint mismatch');
        },
      }
    );
    const target = `${isIP(address) === 6 ? `[${address}]` : address}:${candidate.port}`;
    return new relayV1.TunnelBroker(target, credentials, {
      'grpc.ssl_target_name_override': candidate.certificateIdentity,
      'grpc.default_authority': candidate.certificateIdentity,
      'grpc.keepalive_time_ms': 30_000,
      'grpc.keepalive_timeout_ms': 10_000,
      'grpc.keepalive_permit_without_calls': 1,
      'grpc.max_send_message_length': 16 * 1024 * 1024,
      'grpc.max_receive_message_length': 16 * 1024 * 1024,
    });
  }

  private openTunnelWithBroker(broker: any, grant: SignedRelayGrant, timeoutMs: number): Promise<Duplex> {
    return this.openStreamWithBroker(broker, grant, timeoutMs, (stream, maxFrameBytes) => {
      return new RelayTunnelDuplex(stream, maxFrameBytes);
    });
  }

  private openStreamWithBroker<T>(
    broker: any,
    grant: SignedRelayGrant,
    timeoutMs: number,
    wrap: (stream: RelayTunnelStream, maxFrameBytes: number) => T
  ): Promise<T> {
    const stream = broker.OpenTunnel() as RelayTunnelStream;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stream.cancel();
        reject(new Error('Relay tunnel open timed out'));
      }, timeoutMs);
      timer.unref?.();
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      stream.once('error', fail);
      stream.on('data', (message) => {
        if (settled) return;
        if (message.ready) {
          const maxFrameBytes = Math.min(RELAY_MAX_FRAME_BYTES, Number(message.ready.maxFrameBytes) || 0);
          if (maxFrameBytes <= 0) {
            fail(new Error('Relay returned an invalid frame limit'));
            return;
          }
          settled = true;
          clearTimeout(timer);
          stream.off('error', fail);
          resolve(wrap(stream, maxFrameBytes));
        } else if (message.error) fail(new Error(message.error.message.slice(0, 256)));
        else fail(new Error('Relay returned an invalid open response'));
      });
      stream.write({ open: { grant } });
    });
  }

  private unary(method: string, request: unknown, timeoutMs: number): Promise<unknown> {
    return this.unaryWith(this.admin, method, request, timeoutMs);
  }

  private unaryWith(admin: any, method: string, request: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      admin[method](request, { deadline: Date.now() + timeoutMs }, (error: Error | null, response: unknown) =>
        error ? reject(error) : resolve(response)
      );
    });
  }

  private async flushPendingIdentityCommit(timeoutMs: number): Promise<void> {
    const operationId = this.pendingIdentityCommit;
    if (!operationId) return;
    const result = (await this.unary('CommitIdentityRotation', { operationId }, timeoutMs)) as {
      committed?: boolean;
    };
    if (result.committed === true && this.pendingIdentityCommit === operationId) {
      this.pendingIdentityCommit = undefined;
    }
  }
}

function channelOf(client: any): grpc.Channel | null {
  try {
    return typeof client?.getChannel === 'function' ? (client.getChannel() as grpc.Channel) : null;
  } catch {
    return null;
  }
}

function normalizeCertificateFingerprint(value: string): string {
  return value
    .replace(/^sha256:/i, '')
    .replaceAll(':', '')
    .toLowerCase();
}
