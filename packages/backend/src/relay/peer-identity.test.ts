import { describe, expect, it } from 'vitest';
import { extractRelayPeerCertificateIdentity } from './peer-identity.js';

function callWithPeer(peer: Record<string, unknown>, authorized = true) {
  return {
    handler: {
      call: {
        stream: {
          session: {
            socket: {
              authorized,
              getPeerCertificate: () => peer,
            },
          },
        },
      },
    },
  };
}

describe('extractRelayPeerCertificateIdentity', () => {
  it('returns the authorized service certificate identity and fingerprint', () => {
    const identity = extractRelayPeerCertificateIdentity(
      callWithPeer({
        subject: { CN: 'app-relay-client' },
        serialNumber: 'AA:01',
        raw: Buffer.from('certificate'),
      }) as never
    );
    expect(identity).toEqual({
      commonName: 'app-relay-client',
      serialNumber: 'aa01',
      fingerprintSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('rejects a peer when TLS authorization is not proven', () => {
    expect(
      extractRelayPeerCertificateIdentity(
        callWithPeer(
          { subject: { CN: 'app-relay-client' }, serialNumber: 'AA:01', raw: Buffer.from('certificate') },
          false
        ) as never
      )
    ).toBeNull();
  });

  it('rejects incomplete peer certificates', () => {
    expect(extractRelayPeerCertificateIdentity(callWithPeer({ subject: {} }) as never)).toBeNull();
  });
});
