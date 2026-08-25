import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { nodes } from './nodes.js';

export const relaySigningKeyStatusEnum = pgEnum('relay_signing_key_status', [
  'pending',
  'active',
  'verification_only',
  'retired',
]);

export const relayInstanceKindEnum = pgEnum('relay_instance_kind', ['local', 'remote']);
export const relayInstanceStateEnum = pgEnum('relay_instance_state', [
  'joining',
  'synchronizing',
  'ready',
  'draining',
  'offline',
  'error',
]);
export const relayAssignmentGenerationStateEnum = pgEnum('relay_assignment_generation_state', [
  'staging',
  'active',
  'draining',
  'retired',
  'failed',
]);
export const relayAssignmentRoleEnum = pgEnum('relay_assignment_role', ['primary', 'fallback', 'active']);
export const relayProbeStateEnum = pgEnum('relay_probe_state', ['pending', 'ready', 'failed']);
export const relayPoolUpdateStateEnum = pgEnum('relay_pool_update_state', [
  'preflight',
  'draining',
  'updating',
  'verifying',
  'paused',
  'rolling_back',
  'complete',
  'failed',
]);
export const relayPoolUpdateStepStateEnum = pgEnum('relay_pool_update_step_state', [
  'pending',
  'draining',
  'updating',
  'verifying',
  'ready',
  'rolling_back',
  'rolled_back',
  'failed',
]);

export interface RelayInstanceCapabilities {
  protocolMajor: number;
  features: string[];
  architecture?: string;
}

export interface RelayInstanceHealth {
  activeTunnels?: number;
  registeredEndpoints?: number;
  pressurePercent?: number;
  cpuPressurePercent?: number;
  memoryPressurePercent?: number;
  fdPressurePercent?: number;
  admissionState?: string;
  assignmentTunnels?: Array<{ endpointId: string; assignmentGeneration: number; activeTunnels: number }>;
  policySigningKeyIds?: string[];
}

export interface RelayArtifactDescriptor {
  version: string;
  digest: string;
  architecture?: string;
  image?: string;
  url?: string;
}

export const relayGrantSigningKeys = pgTable(
  'relay_grant_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: relaySigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    privateKeyDestroyedAt: timestamp('private_key_destroyed_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => ({
    keyIdUnique: unique('relay_grant_signing_keys_key_id_unique').on(table.keyId),
    statusIdx: index('relay_grant_signing_keys_status_idx').on(table.status),
  })
);

export const relayPolicySigningKeys = pgTable(
  'relay_policy_signing_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: varchar('key_id', { length: 64 }).notNull(),
    publicKey: text('public_key').notNull(),
    publicKeyFingerprint: varchar('public_key_fingerprint', { length: 71 }).notNull(),
    encryptedPrivateKey: text('encrypted_private_key'),
    encryptedDek: text('encrypted_dek'),
    status: relaySigningKeyStatusEnum('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    verifyUntil: timestamp('verify_until', { withTimezone: true }),
    privateKeyDestroyedAt: timestamp('private_key_destroyed_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => ({
    keyIdUnique: unique('relay_policy_signing_keys_key_id_unique').on(table.keyId),
    statusIdx: index('relay_policy_signing_keys_status_idx').on(table.status),
  })
);

export const relayPools = pgTable('relay_pools', {
  id: varchar('id', { length: 32 }).primaryKey(),
  gatewayHostIdentityId: uuid('gateway_host_identity_id').notNull().defaultRandom(),
  desiredPolicyRevision: bigint('desired_policy_revision', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relayPolicyState = pgTable('relay_policy_state', {
  id: varchar('id', { length: 32 }).primaryKey(),
  gatewayInstanceId: uuid('gateway_instance_id').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relayEndpoints = pgTable(
  'relay_endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    activeAssignmentGeneration: bigint('active_assignment_generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: text('owner_id').notNull(),
    subjectKind: varchar('subject_kind', { length: 32 }).notNull(),
    subjectId: text('subject_id').notNull(),
    certificateSha256: varchar('certificate_sha256', { length: 71 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(256),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUnique: unique('relay_endpoints_owner_unique').on(table.ownerKind, table.ownerId),
    subjectIdx: index('relay_endpoints_subject_idx').on(table.subjectKind, table.subjectId),
  })
);

export const relayRoutes = pgTable(
  'relay_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    ownerKind: varchar('owner_kind', { length: 64 }).notNull(),
    ownerId: text('owner_id').notNull(),
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    sourceId: text('source_id').notNull(),
    sourceCertificateSha256: varchar('source_certificate_sha256', { length: 71 }).notNull(),
    targetEndpointId: uuid('target_endpoint_id')
      .notNull()
      .references(() => relayEndpoints.id, { onDelete: 'cascade' }),
    maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(16),
    maxFrameBytes: integer('max_frame_bytes')
      .notNull()
      .default(1024 * 1024),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerUnique: unique('relay_routes_owner_unique').on(table.ownerKind, table.ownerId),
    sourceIdx: index('relay_routes_source_idx').on(table.sourceKind, table.sourceId),
    targetIdx: index('relay_routes_target_idx').on(table.targetEndpointId),
  })
);

export const dockerRegistryNodeBindings = pgTable(
  'docker_registry_node_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).$type<'builder' | 'runtime'>().notNull(),
    repository: text('repository').notNull(),
    actions: text('actions').array().notNull(),
    contextKind: varchar('context_kind', { length: 32 }).$type<'build' | 'container' | 'deployment'>().notNull(),
    contextId: text('context_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    contextUnique: unique('docker_registry_node_bindings_context_unique').on(
      table.nodeId,
      table.role,
      table.contextKind,
      table.contextId,
      table.repository
    ),
    nodeStatusIdx: index('docker_registry_node_bindings_node_status_idx').on(table.nodeId, table.status),
  })
);

export const relayInstances = pgTable(
  'relay_instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: varchar('pool_id', { length: 32 })
      .notNull()
      .references(() => relayPools.id, { onDelete: 'cascade' }),
    kind: relayInstanceKindEnum('kind').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'restrict' }),
    faultDomainId: uuid('fault_domain_id').notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    advertisedAddresses: text('advertised_addresses').array().notNull().default([]),
    servicePort: integer('service_port').notNull().default(9443),
    state: relayInstanceStateEnum('state').notNull().default('joining'),
    certificateIdentity: varchar('certificate_identity', { length: 255 }),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }),
    certificateExpiresAt: timestamp('certificate_expires_at', { withTimezone: true }),
    policySigningKeyId: varchar('policy_signing_key_id', { length: 64 }),
    policyPublicKeyFingerprint: varchar('policy_public_key_fingerprint', { length: 71 }),
    buildVersion: varchar('build_version', { length: 64 }),
    protocolMajor: integer('protocol_major'),
    capabilities: jsonb('capabilities').$type<RelayInstanceCapabilities>(),
    appliedPolicyRevision: bigint('applied_policy_revision', { mode: 'number' }).notNull().default(0),
    policyExpiresAt: timestamp('policy_expires_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    health: jsonb('health').$type<RelayInstanceHealth>(),
    desiredArtifact: jsonb('desired_artifact').$type<RelayArtifactDescriptor>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    poolFaultDomainUnique: unique('relay_instances_pool_fault_domain_unique').on(table.poolId, table.faultDomainId),
    nodeUnique: unique('relay_instances_node_unique').on(table.nodeId),
    poolStateIdx: index('relay_instances_pool_state_idx').on(table.poolId, table.state),
    servicePortValid: check(
      'relay_instances_service_port_valid',
      sql`${table.servicePort} > 0 AND ${table.servicePort} <= 65535`
    ),
  })
);

export const relayEndpointAssignmentGenerations = pgTable(
  'relay_endpoint_assignment_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => relayEndpoints.id, { onDelete: 'cascade' }),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    state: relayAssignmentGenerationStateEnum('state').notNull().default('staging'),
    desiredRedundancy: integer('desired_redundancy').notNull().default(1),
    activationError: text('activation_error'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    drainStartedAt: timestamp('drain_started_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointGenerationUnique: unique('relay_assignment_generations_endpoint_generation_unique').on(
      table.endpointId,
      table.generation
    ),
    endpointStateIdx: index('relay_assignment_generations_endpoint_state_idx').on(table.endpointId, table.state),
    oneActivePerEndpoint: uniqueIndex('relay_assignment_generations_one_active_per_endpoint')
      .on(table.endpointId)
      .where(sql`${table.state} = 'active'`),
    desiredRedundancyValid: check(
      'relay_assignment_generations_desired_redundancy_valid',
      sql`${table.desiredRedundancy} > 0`
    ),
  })
);

export const relayEndpointAssignments = pgTable(
  'relay_endpoint_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentGenerationId: uuid('assignment_generation_id')
      .notNull()
      .references(() => relayEndpointAssignmentGenerations.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    role: relayAssignmentRoleEnum('role').notNull(),
    targetRegistrationState: relayProbeStateEnum('target_registration_state').notNull().default('pending'),
    targetRegisteredAt: timestamp('target_registered_at', { withTimezone: true }),
    targetRegistrationError: text('target_registration_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationInstanceUnique: unique('relay_endpoint_assignments_generation_instance_unique').on(
      table.assignmentGenerationId,
      table.relayInstanceId
    ),
    instanceIdx: index('relay_endpoint_assignments_instance_idx').on(table.relayInstanceId),
  })
);

export const relayAssignmentSourceProbes = pgTable(
  'relay_assignment_source_probes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assignmentGenerationId: uuid('assignment_generation_id')
      .notNull()
      .references(() => relayEndpointAssignmentGenerations.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    sourceKind: varchar('source_kind', { length: 32 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    certificateFingerprint: varchar('certificate_fingerprint', { length: 71 }).notNull(),
    state: relayProbeStateEnum('state').notNull().default('pending'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationSourceInstanceUnique: unique('relay_source_probes_generation_source_instance_unique').on(
      table.assignmentGenerationId,
      table.sourceKind,
      table.sourceId,
      table.relayInstanceId
    ),
    generationStateIdx: index('relay_source_probes_generation_state_idx').on(table.assignmentGenerationId, table.state),
  })
);

export const relayPoolUpdateRuns = pgTable(
  'relay_pool_update_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: varchar('pool_id', { length: 32 })
      .notNull()
      .references(() => relayPools.id, { onDelete: 'cascade' }),
    state: relayPoolUpdateStateEnum('state').notNull().default('preflight'),
    targetArtifact: jsonb('target_artifact').$type<RelayArtifactDescriptor>().notNull(),
    compatibility: jsonb('compatibility').$type<Record<string, unknown>>(),
    forceDisconnectApproved: boolean('force_disconnect_approved').notNull().default(false),
    terminalError: text('terminal_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    poolStateIdx: index('relay_pool_update_runs_pool_state_idx').on(table.poolId, table.state),
    oneActiveRunPerPool: uniqueIndex('relay_pool_update_runs_one_active_per_pool')
      .on(table.poolId)
      .where(sql`${table.state} in ('preflight', 'draining', 'updating', 'verifying', 'paused', 'rolling_back')`),
  })
);

export const relayPoolUpdateSteps = pgTable(
  'relay_pool_update_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => relayPoolUpdateRuns.id, { onDelete: 'cascade' }),
    relayInstanceId: uuid('relay_instance_id')
      .notNull()
      .references(() => relayInstances.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    state: relayPoolUpdateStepStateEnum('state').notNull().default('pending'),
    previousArtifact: jsonb('previous_artifact').$type<RelayArtifactDescriptor>(),
    targetArtifact: jsonb('target_artifact').$type<RelayArtifactDescriptor>().notNull(),
    drainDeadlineAt: timestamp('drain_deadline_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runInstanceUnique: unique('relay_pool_update_steps_run_instance_unique').on(table.runId, table.relayInstanceId),
    runSequenceUnique: unique('relay_pool_update_steps_run_sequence_unique').on(table.runId, table.sequence),
  })
);
