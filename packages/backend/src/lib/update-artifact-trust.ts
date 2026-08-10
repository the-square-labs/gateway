import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPDATE_SIGNING_KEY_ID = 'wiolett-update-v1';

export const UPDATE_SIGNING_PUBLIC_KEY_PEM = loadUpdateSigningPublicKey();

const UPDATE_SCHEMA_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export class UpdateArtifactTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateArtifactTrustError';
  }
}

interface SignedUpdateEnvelope {
  schemaVersion: number;
  keyId: string;
  payload: string;
  signature: string;
}

export interface DaemonUpdateManifestPayload {
  kind: 'daemon-binary';
  version: string;
  tag: string;
  daemonType: 'nginx' | 'docker' | 'monitoring';
  arch: string;
  artifactName: string;
  downloadUrl: string;
  sha256: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface GatewayImageManifestPayload {
  kind: 'gateway-image';
  version: string;
  tag: string;
  image: string;
  digest: string;
  imageRef: string;
  relayBuildVersion: string;
  relayProtocolMajor: number;
  relayImageRef: string;
  databaseConnectorImage?: string;
  secureLinkConnectorImage?: string;
  createdAt: string;
  gitCommitSha?: string;
  gitPipelineId?: string;
}

export interface TrustedDaemonUpdateArtifact {
  payload: DaemonUpdateManifestPayload;
  signedManifest: string;
  downloadUrl: string;
  checksum: string;
}

export interface TrustedGatewayUpdateArtifact {
  payload: GatewayImageManifestPayload;
  signedManifest: string;
  imageRef: string;
  digest: string;
  relayBuildVersion: string;
  relayProtocolMajor: number;
  relayImageRef: string;
  databaseConnectorImage?: string;
  secureLinkConnectorImage?: string;
}

export interface DaemonUpdateManifestExpectation {
  daemonType: DaemonUpdateManifestPayload['daemonType'];
  version: string;
  tag: string;
  arch: string;
  artifactName: string;
  downloadUrl: string;
  trustedPackagePrefix: string;
}

export interface GatewayImageManifestExpectation {
  version: string;
  tag: string;
  image: string;
}

export function verifyDaemonUpdateManifest(
  signedManifest: string,
  expected: DaemonUpdateManifestExpectation
): TrustedDaemonUpdateArtifact {
  const payload = verifySignedPayload<DaemonUpdateManifestPayload>(signedManifest);
  if (payload.kind !== 'daemon-binary') throw new UpdateArtifactTrustError('Update manifest kind is not daemon-binary');
  if (payload.daemonType !== expected.daemonType) throw new UpdateArtifactTrustError('Update daemon type mismatch');
  if (payload.version !== expected.version) throw new UpdateArtifactTrustError('Update version mismatch');
  if (payload.tag !== expected.tag) throw new UpdateArtifactTrustError('Update tag mismatch');
  if (payload.arch !== expected.arch) throw new UpdateArtifactTrustError('Update architecture mismatch');
  if (payload.artifactName !== expected.artifactName)
    throw new UpdateArtifactTrustError('Update artifact name mismatch');
  if (payload.downloadUrl !== expected.downloadUrl) throw new UpdateArtifactTrustError('Update download URL mismatch');
  if (!isTrustedHttpsUrl(payload.downloadUrl, expected.trustedPackagePrefix)) {
    throw new UpdateArtifactTrustError('Update download URL is not trusted');
  }
  if (!SHA256_RE.test(payload.sha256)) throw new UpdateArtifactTrustError('Update checksum is invalid');

  return {
    payload,
    signedManifest,
    downloadUrl: payload.downloadUrl,
    checksum: payload.sha256,
  };
}

export function verifyGatewayImageManifest(
  signedManifest: string,
  expected: GatewayImageManifestExpectation,
  publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM
): TrustedGatewayUpdateArtifact {
  const payload = verifySignedPayload<GatewayImageManifestPayload>(signedManifest, publicKey);
  if (payload.kind !== 'gateway-image') throw new UpdateArtifactTrustError('Update manifest kind is not gateway-image');
  if (payload.version !== expected.version) throw new UpdateArtifactTrustError('Gateway update version mismatch');
  if (payload.tag !== expected.tag) throw new UpdateArtifactTrustError('Gateway update tag mismatch');
  if (payload.image !== expected.image) throw new UpdateArtifactTrustError('Gateway update image mismatch');
  if (!DIGEST_RE.test(payload.digest)) throw new UpdateArtifactTrustError('Gateway update digest is invalid');
  if (payload.imageRef !== `${payload.image}@${payload.digest}`) {
    throw new UpdateArtifactTrustError('Gateway update image reference is not digest pinned');
  }
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(payload.relayBuildVersion)) {
    throw new UpdateArtifactTrustError('Gateway update relay build version is invalid');
  }
  if (!Number.isInteger(payload.relayProtocolMajor) || payload.relayProtocolMajor < 1) {
    throw new UpdateArtifactTrustError('Gateway update relay protocol major is invalid');
  }
  if (!isDigestPinnedImageRef(payload.relayImageRef, `${payload.image}/relay`)) {
    throw new UpdateArtifactTrustError('Gateway update relay image reference is not digest pinned');
  }
  if (
    payload.databaseConnectorImage !== undefined &&
    (typeof payload.databaseConnectorImage !== 'string' ||
      !isDigestPinnedImageRef(payload.databaseConnectorImage, `${payload.image}/database-connector`))
  ) {
    throw new UpdateArtifactTrustError('Gateway update database connector image reference is not digest pinned');
  }
  if (
    payload.secureLinkConnectorImage !== undefined &&
    (typeof payload.secureLinkConnectorImage !== 'string' ||
      !isDigestPinnedImageRef(payload.secureLinkConnectorImage, `${payload.image}/secure-link-connector`))
  ) {
    throw new UpdateArtifactTrustError('Gateway update secure-link connector image reference is not digest pinned');
  }

  return {
    payload,
    signedManifest,
    imageRef: payload.imageRef,
    digest: payload.digest,
    relayBuildVersion: payload.relayBuildVersion,
    relayProtocolMajor: payload.relayProtocolMajor,
    relayImageRef: payload.relayImageRef,
    ...(payload.databaseConnectorImage ? { databaseConnectorImage: payload.databaseConnectorImage } : {}),
    ...(payload.secureLinkConnectorImage ? { secureLinkConnectorImage: payload.secureLinkConnectorImage } : {}),
  };
}

export function isDigestPinnedImageRef(imageRef: string, repository: string): boolean {
  const digest = imageRef.startsWith(`${repository}@`) ? imageRef.slice(repository.length + 1) : '';
  return DIGEST_RE.test(digest);
}

export function trustedGitLabPackagePrefix(gitlabApiUrl: string, projectPath: string): string {
  const base = normalizeGitLabApiUrl(gitlabApiUrl);
  const encodedPath = encodeURIComponent(projectPath);
  return `${base}/api/v4/projects/${encodedPath}/packages/generic/`;
}

export function normalizeGitLabApiUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function verifySignedPayload<T>(signedManifest: string, publicKey: string | Buffer = UPDATE_SIGNING_PUBLIC_KEY_PEM): T {
  let envelope: SignedUpdateEnvelope;
  try {
    envelope = JSON.parse(signedManifest) as SignedUpdateEnvelope;
  } catch {
    throw new UpdateArtifactTrustError('Update manifest is not valid JSON');
  }

  if (envelope.schemaVersion !== UPDATE_SCHEMA_VERSION) {
    throw new UpdateArtifactTrustError('Update manifest schema version is unsupported');
  }
  if (envelope.keyId !== UPDATE_SIGNING_KEY_ID) throw new UpdateArtifactTrustError('Update manifest key ID is unknown');
  if (typeof envelope.payload !== 'string' || envelope.payload.length === 0) {
    throw new UpdateArtifactTrustError('Update manifest payload is missing');
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.length === 0) {
    throw new UpdateArtifactTrustError('Update manifest signature is missing');
  }

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(envelope.payload, 'base64url');
    signature = Buffer.from(envelope.signature, 'base64url');
  } catch {
    throw new UpdateArtifactTrustError('Update manifest contains invalid base64url data');
  }

  if (!verify(null, payloadBytes, publicKey, signature)) {
    throw new UpdateArtifactTrustError('Update manifest signature is invalid');
  }

  try {
    return JSON.parse(payloadBytes.toString('utf8')) as T;
  } catch {
    throw new UpdateArtifactTrustError('Update manifest payload is not valid JSON');
  }
}

function isTrustedHttpsUrl(value: string, trustedPrefix: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && value.startsWith(trustedPrefix);
  } catch {
    return false;
  }
}

function loadUpdateSigningPublicKey(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // Repo-wide update trust anchor. Docker copies the canonical PEM next to this module.
  const candidates = [
    join(moduleDir, 'update-signing-public-key.pem'),
    join(process.cwd(), 'config/update-trust/update-signing-public-key.pem'),
    join(process.cwd(), '../../config/update-trust/update-signing-public-key.pem'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }

  throw new Error(`Could not locate update signing public key. Tried: ${candidates.join(', ')}`);
}
