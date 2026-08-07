import { createHash } from 'node:crypto';
import type { ServerDuplexStream, ServerUnaryCall } from '@grpc/grpc-js';
import { normalizeRelayCertificateSerial } from './authorization-repository.js';

interface PeerCertificateSocket {
  authorized?: boolean;
  authorizationError?: unknown;
  getPeerCertificate(detailed?: boolean): unknown;
}

export interface RelayPeerCertificateIdentity {
  commonName: string;
  serialNumber: string;
  fingerprintSha256: string;
}

function findPeerCertificateSocket(call: unknown): PeerCertificateSocket | null {
  const seen = new Set<unknown>();
  const keys = ['handler', 'http2Stream', 'call', 'nextCall', 'stream', 'session', 'socket'];
  const visit = (value: unknown, depth: number): PeerCertificateSocket | null => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth < 0) return null;
    seen.add(value);
    if (typeof (value as { getPeerCertificate?: unknown }).getPeerCertificate === 'function') {
      return value as PeerCertificateSocket;
    }
    for (const key of keys) {
      const found = visit((value as Record<string, unknown>)[key], depth - 1);
      if (found) return found;
    }
    return null;
  };
  return visit(call, 8);
}

export function extractRelayPeerCertificateIdentity(
  call: ServerDuplexStream<unknown, unknown> | ServerUnaryCall<unknown, unknown>
): RelayPeerCertificateIdentity | null {
  try {
    const socket = findPeerCertificateSocket(call);
    if (!socket || socket.authorized !== true) return null;
    const authContext =
      typeof (call as { getAuthContext?: unknown }).getAuthContext === 'function' ? call.getAuthContext() : {};
    const authCert = (authContext as { sslPeerCertificate?: unknown }).sslPeerCertificate;
    const socketPeer = socket.getPeerCertificate(false) as {
      subject?: { CN?: unknown };
      serialNumber?: unknown;
      raw?: unknown;
    };
    const contextPeer = authCert as { subject?: { CN?: unknown }; serialNumber?: unknown; raw?: unknown } | undefined;
    const peer = {
      subject: contextPeer?.subject ?? socketPeer?.subject,
      serialNumber: contextPeer?.serialNumber ?? socketPeer?.serialNumber,
      raw: socketPeer?.raw ?? contextPeer?.raw,
    };
    const commonName = peer?.subject?.CN;
    const serialNumber = peer?.serialNumber;
    if (typeof commonName !== 'string' || typeof serialNumber !== 'string' || !Buffer.isBuffer(peer.raw)) return null;
    return {
      commonName,
      serialNumber: normalizeRelayCertificateSerial(serialNumber),
      fingerprintSha256: `sha256:${createHash('sha256').update(peer.raw).digest('hex')}`,
    };
  } catch {
    return null;
  }
}
