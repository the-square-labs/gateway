import { createHash } from 'node:crypto';
import type { ServerDuplexStream, ServerUnaryCall } from '@grpc/grpc-js';
import { createChildLogger } from '@/lib/logger.js';

const logger = createChildLogger('GrpcAuth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELAY_METADATA = {
  nodeId: 'x-wiolett-relay-node-id',
  certificateSerial: 'x-wiolett-relay-cert-serial',
  certificateFingerprint: 'x-wiolett-relay-cert-sha256',
} as const;
let trustedRelayFingerprints = new Set<string>();
let relayTrustGeneration = 0;

function getPeerCertificateSocket(call: unknown): {
  authorized?: boolean;
  authorizationError?: unknown;
  getPeerCertificate: (detailed?: boolean) => unknown;
} | null {
  const seen = new Set<unknown>();
  const keys = ['handler', 'http2Stream', 'call', 'nextCall', 'stream', 'session', 'socket'];

  function visit(value: unknown, depth: number): ReturnType<typeof getPeerCertificateSocket> {
    if (!value || typeof value !== 'object' || seen.has(value) || depth < 0) {
      return null;
    }
    seen.add(value);

    const candidate = value as {
      getPeerCertificate?: unknown;
      authorized?: boolean;
      authorizationError?: unknown;
    };
    if (typeof candidate.getPeerCertificate === 'function') {
      return candidate as {
        authorized?: boolean;
        authorizationError?: unknown;
        getPeerCertificate: (detailed?: boolean) => unknown;
      };
    }

    for (const key of keys) {
      const found = visit((value as Record<string, unknown>)[key], depth - 1);
      if (found) return found;
    }
    return null;
  }

  return visit(call, 8);
}

export interface DaemonCertificateIdentity {
  nodeId: string;
  serialNumber: string;
  certificateFingerprint?: string;
}

export function configureRelayForwardedIdentityTrust(fingerprint: string | null): void {
  relayTrustGeneration += 1;
  trustedRelayFingerprints = fingerprint ? new Set([fingerprint]) : new Set();
}

/**
 * Trust both the current and next relay leaf during a bounded live-rotation
 * window. The returned commit drops the old fingerprint only after the relay
 * explicitly confirms that the new identity files were loaded.
 */
export function stageRelayForwardedIdentityTrust(nextFingerprint: string): () => void {
  const generation = ++relayTrustGeneration;
  trustedRelayFingerprints = new Set([...trustedRelayFingerprints, nextFingerprint]);
  let committed = false;
  const commit = () => {
    if (committed || generation !== relayTrustGeneration) return;
    committed = true;
    configureRelayForwardedIdentityTrust(nextFingerprint);
  };
  return commit;
}

export function isTrustedRelayServiceCall(
  call: ServerDuplexStream<unknown, unknown> | ServerUnaryCall<unknown, unknown>
): boolean {
  if (trustedRelayFingerprints.size === 0) return false;
  const socket = getPeerCertificateSocket(call);
  if (!socket || socket.authorized !== true) return false;
  const peer = socket.getPeerCertificate(false) as { raw?: unknown };
  if (!Buffer.isBuffer(peer?.raw)) return false;
  const fingerprint = `sha256:${createHash('sha256').update(peer.raw).digest('hex')}`;
  return trustedRelayFingerprints.has(fingerprint);
}

export function normalizeCertificateSerial(serial: string): string {
  return serial.trim().replace(/:/g, '').toLowerCase();
}

/**
 * Extract the authenticated daemon identity from a gRPC call's mTLS client certificate.
 *
 * Node certificates are issued with CN = nodeId (a UUID) during enrollment
 * (see system-ca.service.ts issueNodeCert).
 *
 * This reads the peer certificate from grpc-js auth context or the underlying
 * TLS socket and returns CN plus certificate serial only when TLS authorization
 * is definitely successful.
 *
 * Enrollment service should NOT use this (clients have no cert yet).
 * Enrolled daemon services MUST bind this identity to nodes.certificateSerial.
 */
export function extractDaemonCertificateIdentity(
  call: ServerDuplexStream<unknown, unknown> | ServerUnaryCall<unknown, unknown>
): DaemonCertificateIdentity | null {
  try {
    // grpc-js exposes the peer certificate via getAuthContext(), but the TLS
    // authorization flag only lives on the underlying socket. Walk the known
    // call chain shapes because unary and bidi stream objects differ.
    const socket = getPeerCertificateSocket(call);
    if (!socket) {
      logger.warn('Client cert rejected: no TLS socket with peer certificate access');
      return null;
    }
    if (socket.authorized !== true) {
      logger.warn('Client cert rejected: mTLS authorization is missing or failed', {
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
      });
      return null;
    }

    if (trustedRelayFingerprints.size > 0) {
      if (!isTrustedRelayServiceCall(call)) {
        logger.warn('Forwarded daemon identity rejected: peer is not the current relay service identity');
        return null;
      }
      const readOne = (key: string): string | null => {
        const values = call.metadata.get(key);
        return values.length === 1 && typeof values[0] === 'string' ? values[0] : null;
      };
      const nodeId = readOne(RELAY_METADATA.nodeId);
      const serialNumber = readOne(RELAY_METADATA.certificateSerial);
      const certificateFingerprint = readOne(RELAY_METADATA.certificateFingerprint);
      if (
        !nodeId ||
        !UUID_RE.test(nodeId) ||
        !serialNumber ||
        !certificateFingerprint?.match(/^sha256:[0-9a-f]{64}$/)
      ) {
        logger.warn('Forwarded daemon identity rejected: metadata is missing or invalid');
        return null;
      }
      return {
        nodeId,
        serialNumber: normalizeCertificateSerial(serialNumber),
        certificateFingerprint,
      };
    }

    const authContext =
      typeof (call as { getAuthContext?: unknown }).getAuthContext === 'function' ? call.getAuthContext() : {};
    const authCert = (authContext as { sslPeerCertificate?: unknown }).sslPeerCertificate;
    const peerCert = authCert ?? socket.getPeerCertificate(false);

    if (!peerCert || typeof peerCert !== 'object') {
      logger.warn('Client cert rejected: peer certificate missing');
      return null;
    }

    const subject = (peerCert as { subject?: { CN?: unknown } }).subject;
    const cn = subject?.CN;
    if (!cn || typeof cn !== 'string' || !UUID_RE.test(cn)) {
      logger.warn('Client cert rejected: CN is missing or not a valid node UUID', { cn });
      return null;
    }

    const rawSerial = (peerCert as { serialNumber?: unknown }).serialNumber;
    if (!rawSerial || typeof rawSerial !== 'string') {
      logger.warn('Client cert rejected: serial number is missing', { nodeId: cn });
      return null;
    }

    const serialNumber = normalizeCertificateSerial(rawSerial);
    if (!serialNumber) {
      logger.warn('Client cert rejected: serial number is empty after normalization', { nodeId: cn });
      return null;
    }

    return { nodeId: cn, serialNumber };
  } catch (err) {
    logger.debug('Could not extract daemon certificate identity', { error: (err as Error).message });
    return null;
  }
}

export function extractNodeIdFromCert(
  call: ServerDuplexStream<unknown, unknown> | ServerUnaryCall<unknown, unknown>
): string | null {
  return extractDaemonCertificateIdentity(call)?.nodeId ?? null;
}
