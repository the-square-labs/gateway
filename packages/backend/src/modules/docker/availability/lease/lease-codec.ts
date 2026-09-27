import { createHash } from 'node:crypto';
import type { DockerAvailabilityLeaseBallot } from '@/db/schema/index.js';
import { decodeRelayV1Message, encodeRelayV1Message } from '@/grpc/relay-proto.js';

/**
 * Byte-exact counterparts of daemon-shared/availabilitylease (crypto.go, keychain.go). Every signed byte string
 * starts with its domain and a zero byte, so a signature can never be replayed as another message type.
 */
export const LEASE_SIGNATURE_DOMAINS = {
  manifest: 'gateway-availability-lease/manifest/v1',
  voterConfig: 'gateway-availability-lease/voter-config/v1',
  keyRotation: 'gateway-availability-lease/key-rotation/v1',
} as const;

export type LeaseBlockKind = 'LEASE_BLOCK_KIND_MANIFEST' | 'LEASE_BLOCK_KIND_VOTER_CONFIG';

export interface LeaseSignedBlockValue {
  signingKeyId: string;
  kind: LeaseBlockKind;
  payload: Buffer;
  signature: Buffer;
}

export interface LeaseKeyRotationValue {
  previousKeyId: string;
  keyId: string;
  publicKey: Buffer;
  publicKeyFingerprint: string;
  signature: Buffer;
}

export type LeaseSigner = (message: Buffer, keyId: string) => Promise<{ signingKeyId: string; signature: Buffer }>;

function statementPrefix(domain: string): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), Buffer.from([0])]);
}

function lengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

/** domain || 0x00 || payload: what the policy key signs for a manifest or voter config block. */
export function leaseBlockMessage(kind: LeaseBlockKind, payload: Buffer): Buffer {
  const domain =
    kind === 'LEASE_BLOCK_KIND_VOTER_CONFIG' ? LEASE_SIGNATURE_DOMAINS.voterConfig : LEASE_SIGNATURE_DOMAINS.manifest;
  return Buffer.concat([statementPrefix(domain), payload]);
}

/** domain || 0x00 || be32(len(keyId)) || keyId || publicKey: what the previous key signs for a rotation link (A14). */
export function leaseKeyRotationMessage(keyId: string, publicKey: Buffer): Buffer {
  return Buffer.concat([
    statementPrefix(LEASE_SIGNATURE_DOMAINS.keyRotation),
    lengthPrefixed(Buffer.from(keyId, 'utf8')),
    publicKey,
  ]);
}

/** "sha256:<hex>" of a raw Ed25519 policy key, as the relay policy store and availabilitylease compute it. */
export function policyKeyFingerprint(publicKey: Buffer): string {
  return `sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
}

export async function signLeaseBlock(
  kind: LeaseBlockKind,
  payload: Buffer,
  keyId: string,
  sign: LeaseSigner
): Promise<LeaseSignedBlockValue> {
  const signed = await sign(leaseBlockMessage(kind, payload), keyId);
  return { signingKeyId: signed.signingKeyId, kind, payload, signature: signed.signature };
}

export function encodeLeaseSignedBlock(block: LeaseSignedBlockValue): Buffer {
  return encodeRelayV1Message('LeaseSignedBlock', block);
}

export function decodeLeaseSignedBlock(encoded: Buffer): LeaseSignedBlockValue {
  const decoded = decodeRelayV1Message('LeaseSignedBlock', encoded) as {
    signingKeyId: string;
    kind: LeaseBlockKind;
    payload: Buffer;
    signature: Buffer;
  };
  return {
    signingKeyId: decoded.signingKeyId,
    kind: decoded.kind,
    payload: Buffer.from(decoded.payload),
    signature: Buffer.from(decoded.signature),
  };
}

export function encodeLeaseKeyRotation(link: LeaseKeyRotationValue): Buffer {
  return encodeRelayV1Message('LeasePolicyKeyRotation', link);
}

export interface LeaseManifestCandidate {
  id: string;
  /** PKIX DER ECDSA P-256 identity key. */
  publicKey: Buffer;
}

export interface LeaseManifestContent {
  policyId: string;
  mode: 'failover' | 'replicated';
  partitionMode: 'strict' | 'available';
  slots: number;
  /** Ordered: the index is the takeover rank (D5). */
  candidates: LeaseManifestCandidate[];
  specFingerprint: string;
  epoch: number;
  closed: boolean;
  bootstrapId: number;
  bootstrap: Array<{ slot: number; holderId: string }>;
}

/** Serialized relay.v1.LeaseManifest; schema version 1 and the fixed 30 s term. */
export function encodeLeaseManifest(content: LeaseManifestContent, manifestVersion: number): Buffer {
  return encodeRelayV1Message('LeaseManifest', {
    schemaVersion: 1,
    policyId: content.policyId,
    manifestVersion: String(manifestVersion),
    mode: content.mode === 'replicated' ? 'LEASE_POLICY_MODE_REPLICATED' : 'LEASE_POLICY_MODE_FAILOVER',
    partitionMode:
      content.partitionMode === 'available' ? 'LEASE_PARTITION_MODE_AVAILABLE' : 'LEASE_PARTITION_MODE_STRICT',
    slots: content.slots,
    candidates: content.candidates.map((candidate) => ({ id: candidate.id, publicKey: candidate.publicKey })),
    specFingerprint: content.specFingerprint,
    epoch: String(content.epoch),
    closed: content.closed,
    bootstrapId: String(content.bootstrapId),
    bootstrap: content.bootstrap.map((entry) => ({ slot: entry.slot, holderId: entry.holderId })),
    leaseTermMs: 30_000,
  });
}

/** Digest of everything a manifest says except its version: a new digest publishes a new version. */
export function leaseManifestDigest(content: LeaseManifestContent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...content,
        candidates: content.candidates.map((candidate) => [candidate.id, candidate.publicKey.toString('base64')]),
      })
    )
    .digest('hex');
}

export interface LeaseVoterConfigContent {
  epoch: number;
  members: Array<{ id: string; role: 'relay' | 'daemon'; publicKey: Buffer }>;
  /** One set when settled, two (old, new) during a joint-consensus change. */
  quorumSets: string[][];
}

export function encodeLeaseVoterConfig(content: LeaseVoterConfigContent): Buffer {
  return encodeRelayV1Message('LeaseVoterConfig', {
    schemaVersion: 1,
    epoch: String(content.epoch),
    members: content.members.map((member) => ({
      id: member.id,
      publicKey: member.publicKey,
      role: member.role === 'relay' ? 'LEASE_MEMBER_ROLE_RELAY' : 'LEASE_MEMBER_ROLE_DAEMON',
    })),
    quorumSets: content.quorumSets.map((voterIds) => ({ voterIds })),
  });
}

function uint(value: string | undefined): bigint {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}

/** Ballots order by (round, incarnation, proposer), exactly like availabilitylease.Ballot.Compare. */
export function compareLeaseBallots(
  left: DockerAvailabilityLeaseBallot | null | undefined,
  right: DockerAvailabilityLeaseBallot | null | undefined
): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const leftRound = uint(left.round);
  const rightRound = uint(right.round);
  if (leftRound !== rightRound) return leftRound < rightRound ? -1 : 1;
  const leftIncarnation = uint(left.incarnation);
  const rightIncarnation = uint(right.incarnation);
  if (leftIncarnation !== rightIncarnation) return leftIncarnation < rightIncarnation ? -1 : 1;
  if (left.proposerId === right.proposerId) return 0;
  return left.proposerId < right.proposerId ? -1 : 1;
}

export function normalizeLeaseBallot(
  value: { round?: string; incarnation?: string; proposerId?: string } | null | undefined
): DockerAvailabilityLeaseBallot | null {
  if (!value) return null;
  const ballot = {
    round: String(value.round ?? '0'),
    incarnation: String(value.incarnation ?? '0'),
    proposerId: String(value.proposerId ?? ''),
  };
  return ballot.round === '0' && ballot.incarnation === '0' && ballot.proposerId === '' ? null : ballot;
}
