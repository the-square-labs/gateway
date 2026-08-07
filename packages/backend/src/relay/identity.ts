import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const RELAY_IDENTITY_FILES = {
  systemCa: 'system-ca.crt',
  externalCertificate: 'external-server.crt',
  externalPrivateKey: 'external-server.key',
  appClientCertificate: 'app-relay-client.crt',
  appClientPrivateKey: 'app-relay-client.key',
  relayClientCertificate: 'relay-app-client.crt',
  relayClientPrivateKey: 'relay-app-client.key',
  trustManifest: 'trust-manifest.json',
} as const;

export interface RelayTrustManifest {
  version: 1;
  appRelayClientFingerprint: string;
  relayAppClientFingerprint: string;
}

export interface RelayIdentitySnapshot {
  systemCa: Buffer;
  externalCertificate: Buffer;
  externalPrivateKey: Buffer;
  appClientCertificate: Buffer;
  appClientPrivateKey: Buffer;
  relayClientCertificate: Buffer;
  relayClientPrivateKey: Buffer;
  trust: RelayTrustManifest;
  revision: string;
}

const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

export class RelayIdentityStore {
  private current: RelayIdentitySnapshot | null = null;

  constructor(private readonly identityDir: string) {}

  load(): RelayIdentitySnapshot {
    const updateMarker = resolve(this.identityDir, '.updating');
    if (existsSync(updateMarker)) throw new Error('Relay identity material is being updated');
    const read = (name: string) => readFileSync(resolve(this.identityDir, name));
    const trust = JSON.parse(read(RELAY_IDENTITY_FILES.trustManifest).toString('utf8')) as RelayTrustManifest;
    if (
      trust.version !== 1 ||
      !FINGERPRINT_RE.test(trust.appRelayClientFingerprint) ||
      !FINGERPRINT_RE.test(trust.relayAppClientFingerprint)
    ) {
      throw new Error('Relay trust manifest is invalid');
    }
    const revision = Object.values(RELAY_IDENTITY_FILES)
      .map((name) => {
        const stat = statSync(resolve(this.identityDir, name));
        return `${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      })
      .join('|');
    const snapshot: RelayIdentitySnapshot = {
      systemCa: read(RELAY_IDENTITY_FILES.systemCa),
      externalCertificate: read(RELAY_IDENTITY_FILES.externalCertificate),
      externalPrivateKey: read(RELAY_IDENTITY_FILES.externalPrivateKey),
      appClientCertificate: read(RELAY_IDENTITY_FILES.appClientCertificate),
      appClientPrivateKey: read(RELAY_IDENTITY_FILES.appClientPrivateKey),
      relayClientCertificate: read(RELAY_IDENTITY_FILES.relayClientCertificate),
      relayClientPrivateKey: read(RELAY_IDENTITY_FILES.relayClientPrivateKey),
      trust,
      revision,
    };
    if (existsSync(updateMarker)) throw new Error('Relay identity material changed during reload');
    this.current = snapshot;
    return snapshot;
  }

  get(): RelayIdentitySnapshot {
    return this.current ?? this.load();
  }

  reloadIfChanged(): RelayIdentitySnapshot | null {
    const previous = this.current;
    const next = this.load();
    return previous?.revision === next.revision ? null : next;
  }
}
