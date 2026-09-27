import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { dockerAvailabilityPlacements, dockerAvailabilityPolicies } from './docker-availability.js';
import { nodes } from './nodes.js';
import { relayInstances } from './relay.js';

/**
 * How a policy fails over. legacy: the backend reacts to node loss (today's path). bootstrapping: the first lease
 * manifest reserves each slot for its current serving placement and waits for that holder to acquire (A5). lease:
 * the data-plane lease decides and the backend only plans handoffs. closing: a lease-closed manifest fences the
 * holders before legacy takes over again.
 */
export type DockerAvailabilityLeaseMode = 'legacy' | 'bootstrapping' | 'lease' | 'closing';

/** Why a policy is in its lease mode; null when lease mode runs without reservation. */
export interface DockerAvailabilityLeaseReason {
  code: string;
  message: string;
  nodeIds?: string[];
}

/** A lease ballot as reported by the data plane; uint64 parts stay decimal strings. */
export interface DockerAvailabilityLeaseBallot {
  round: string;
  incarnation: string;
  proposerId: string;
}

export interface DockerAvailabilityLeaseBootstrapSlot {
  slot: number;
  holderId: string;
}

/** A handoff the backend asked for, so the resulting holder change is audited as planned (D9). */
export interface DockerAvailabilityLeasePlannedHandoff {
  slot: number;
  fromHolderId: string | null;
  toHolderId: string;
  operationId: string | null;
  expiresAt: string;
}

export const dockerAvailabilityLeaseState = pgTable(
  'docker_availability_lease_state',
  {
    policyId: uuid('policy_id')
      .primaryKey()
      .references(() => dockerAvailabilityPolicies.id, { onDelete: 'cascade' }),
    mode: varchar('mode', { length: 16 }).$type<DockerAvailabilityLeaseMode>().notNull().default('legacy'),
    reason: jsonb('reason').$type<DockerAvailabilityLeaseReason | null>(),
    manifestVersion: bigint('manifest_version', { mode: 'number' }).notNull().default(0),
    manifestEpoch: bigint('manifest_epoch', { mode: 'number' }).notNull().default(0),
    /** Digest of the manifest content without its version; a new digest publishes a new version. */
    manifestDigest: text('manifest_digest'),
    /** Base64 of the serialized relay.v1.LeaseSignedBlock currently published. */
    manifestBlock: text('manifest_block'),
    bootstrapId: bigint('bootstrap_id', { mode: 'number' }).notNull().default(0),
    bootstrap: jsonb('bootstrap').$type<DockerAvailabilityLeaseBootstrapSlot[]>().notNull().default([]),
    /** Partition mode the published manifest carries; available -> strict re-runs bootstrap (A7). */
    publishedPartitionMode: varchar('published_partition_mode', { length: 16 }).$type<'strict' | 'available'>(),
    /** The controller asked for the legacy path (for example before disabling Availability); gating stays closed. */
    legacyRequested: boolean('legacy_requested').notNull().default(false),
    /** A7: when the policy switched from available to strict; strict is active once bootstrap settled. */
    strictRequestedAt: timestamp('strict_requested_at', { withTimezone: true }),
    /**
     * When the reserved holders first held every slot with no other copy reported running. Bootstrap (and a switch to
     * strict) completes only after the relay gate window passed since then (A5, A7, A16).
     */
    copiesStoppedAt: timestamp('copies_stopped_at', { withTimezone: true }),
    closingStartedAt: timestamp('closing_started_at', { withTimezone: true }),
    /** When a voter majority first persisted the lease-closed manifest (A5). */
    closingAckedAt: timestamp('closing_acked_at', { withTimezone: true }),
    plannedHandoffs: jsonb('planned_handoffs').$type<DockerAvailabilityLeasePlannedHandoff[]>().notNull().default([]),
    modeChangedAt: timestamp('mode_changed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'docker_availability_lease_state_mode_check',
      sql`${table.mode} IN ('legacy', 'bootstrapping', 'lease', 'closing')`
    ),
    check(
      'docker_availability_lease_state_version_check',
      sql`${table.manifestVersion} >= 0 AND ${table.manifestEpoch} >= 0 AND ${table.bootstrapId} >= 0`
    ),
  ]
);

/** One member of the cluster voter config as published (D2). */
export interface AvailabilityLeaseClusterMember {
  id: string;
  role: 'relay' | 'daemon';
  /** Base64 PKIX DER ECDSA P-256 identity key. */
  publicKey: string;
}

/** The singleton cluster voter config: epoch, members and quorum sets (two while joint, A4). */
export const availabilityLeaseCluster = pgTable('availability_lease_cluster', {
  id: varchar('id', { length: 32 }).primaryKey(),
  epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
  members: jsonb('members').$type<AvailabilityLeaseClusterMember[]>().notNull().default([]),
  quorumSets: jsonb('quorum_sets').$type<string[][]>().notNull().default([]),
  /** Base64 of the serialized relay.v1.LeaseSignedBlock for the current epoch. */
  voterConfigBlock: text('voter_config_block'),
  /** When the joint epoch was published and when both majorities acked it. */
  jointStartedAt: timestamp('joint_started_at', { withTimezone: true }),
  jointAckedAt: timestamp('joint_acked_at', { withTimezone: true }),
  /** Policy key that signs new lease blocks; moves to a new key only after a voter majority trusts it (A14). */
  signingKeyId: varchar('signing_key_id', { length: 64 }),
  /** Distribution revision, bumped whenever any published block or the key chain changes. */
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A14 rotation links: key_id introduced by previous_key_id, signed by the previous key. */
export const availabilityLeaseKeyRotations = pgTable('availability_lease_key_rotations', {
  keyId: varchar('key_id', { length: 64 }).primaryKey(),
  previousKeyId: varchar('previous_key_id', { length: 64 }).notNull(),
  /** Base64 raw Ed25519 public key. */
  publicKey: text('public_key').notNull(),
  publicKeyFingerprint: varchar('public_key_fingerprint', { length: 71 }).notNull(),
  /** Base64 Ed25519 signature by the previous key. */
  signature: text('signature').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AvailabilityLeaseMemberKind = 'docker' | 'nginx' | 'relay';

/** What each daemon and relay last reported about the lease protocol: identity, capability and persisted acks. */
export const availabilityLeaseMembers = pgTable(
  'availability_lease_members',
  {
    memberId: varchar('member_id', { length: 64 }).primaryKey(),
    kind: varchar('kind', { length: 16 }).$type<AvailabilityLeaseMemberKind>().notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id').references(() => relayInstances.id, { onDelete: 'cascade' }),
    /** Base64 PKIX DER ECDSA P-256 identity key the member signs frames with. */
    identityPublicKey: text('identity_public_key'),
    watchdogReady: boolean('watchdog_ready').notNull().default(false),
    incarnation: bigint('incarnation', { mode: 'number' }).notNull().default(0),
    epochAck: bigint('epoch_ack', { mode: 'number' }).notNull().default(0),
    trustedKeyIds: text('trusted_key_ids').array().notNull().default([]),
    manifestAcks: jsonb('manifest_acks')
      .$type<Record<string, { version: number; closed: boolean }>>()
      .notNull()
      .default({}),
    leaseRevision: bigint('lease_revision', { mode: 'number' }).notNull().default(0),
    abstaining: boolean('abstaining').notNull().default(false),
    reportedAt: timestamp('reported_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('availability_lease_members_kind_check', sql`${table.kind} IN ('docker', 'nginx', 'relay')`),
    index('availability_lease_members_node_idx').on(table.nodeId),
  ]
);

export type DockerAvailabilityLeaseObservationSource = 'daemon' | 'acceptor' | 'relay';

/** The latest observed holder of each lease key (policy, slot), reconciled into placements by the controller. */
export const dockerAvailabilityLeaseObservations = pgTable(
  'docker_availability_lease_observations',
  {
    policyId: uuid('policy_id')
      .notNull()
      .references(() => dockerAvailabilityPolicies.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    /** Candidate id (docker node id) holding the lease; null once it released or fenced. */
    holderId: varchar('holder_id', { length: 64 }),
    placementId: uuid('placement_id').references(() => dockerAvailabilityPlacements.id, { onDelete: 'set null' }),
    ballot: jsonb('ballot').$type<DockerAvailabilityLeaseBallot | null>(),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    manifestVersion: bigint('manifest_version', { mode: 'number' }).notNull().default(0),
    source: varchar('source', { length: 16 }).$type<DockerAvailabilityLeaseObservationSource>().notNull(),
    sourceId: varchar('source_id', { length: 64 }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    holderSince: timestamp('holder_since', { withTimezone: true }),
    lastHolderId: varchar('last_holder_id', { length: 64 }),
    /**
     * Every daemon that last reported a role for this key in which its copy may run (bootstrapping, recovering,
     * holding, fencing, abandoned, releasing). Bootstrap counts as acked only when no one but the reserved holder is
     * listed (A5, A7).
     */
    claimants: jsonb('claimants').$type<Record<string, { role: string; observedAt: string }>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.slot] }),
    check('docker_availability_lease_observations_slot_check', sql`${table.slot} BETWEEN 0 AND 31`),
    check(
      'docker_availability_lease_observations_source_check',
      sql`${table.source} IN ('daemon', 'acceptor', 'relay')`
    ),
  ]
);
