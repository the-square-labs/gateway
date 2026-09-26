import { createHash, X509Certificate } from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  certificates,
  dockerAvailabilityPolicies,
  managedDatabaseBindingPlacements,
  managedDatabaseBindings,
  managedDatabaseInstances,
  managedStorageBindings,
  nodes,
  relayEndpoints,
  relayPolicyState,
  relayRoutes,
} from '@/db/schema/index.js';
import { RELAY_MAX_FRAME_BYTES } from '@/grpc/relay-control.client.js';

const POLICY_ID = 'current';

function fingerprint(certificatePem: string): string {
  const certificate = new X509Certificate(certificatePem);
  return `sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`;
}

export async function bumpRelayPolicyRevision(tx: any): Promise<void> {
  await tx
    .update(relayPolicyState)
    .set({ revision: sql`${relayPolicyState.revision} + 1`, updatedAt: new Date() })
    .where(eq(relayPolicyState.id, POLICY_ID));
}

export async function backfillRelayNodeFingerprints(db: DrizzleClient): Promise<void> {
  const rows = await db
    .select({ id: nodes.id, certificateSerial: nodes.certificateSerial })
    .from(nodes)
    .where(and(isNull(nodes.certificateFingerprint), isNotNull(nodes.certificateSerial)));
  for (const node of rows) {
    const [certificate] = await db
      .select({ certificatePem: certificates.certificatePem })
      .from(certificates)
      .where(eq(certificates.serialNumber, node.certificateSerial!))
      .limit(1);
    if (certificate) {
      await db
        .update(nodes)
        .set({ certificateFingerprint: fingerprint(certificate.certificatePem), updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
    }
  }
}

export async function updateManagedDatabaseRelayStatus(
  db: DrizzleClient,
  managedDatabaseId: string,
  databaseStatus: string
): Promise<boolean> {
  const status = databaseStatus === 'ready' || databaseStatus === 'updating' ? 'active' : 'inactive';
  return db.transaction(async (tx) => {
    const [endpoint] = await tx
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.ownerKind, 'managed_database'), eq(relayEndpoints.ownerId, managedDatabaseId)))
      .limit(1);
    if (!endpoint || endpoint.status === status) return false;
    await tx
      .update(relayEndpoints)
      .set({ status, generation: endpoint.generation + 1, updatedAt: new Date() })
      .where(eq(relayEndpoints.id, endpoint.id));
    await bumpRelayPolicyRevision(tx);
    return true;
  });
}

export async function reconcileManagedDatabaseRelayPolicy(db: DrizzleClient): Promise<void> {
  const [databases, bindings, bindingPlacements, availabilityPolicies, identities] = await Promise.all([
    db
      .select({
        id: managedDatabaseInstances.id,
        nodeId: managedDatabaseInstances.nodeId,
        status: managedDatabaseInstances.status,
      })
      .from(managedDatabaseInstances),
    db
      .select({
        id: managedDatabaseBindings.id,
        managedDatabaseId: managedDatabaseBindings.managedDatabaseId,
        sourceNodeId: managedDatabaseBindings.targetNodeId,
        targetType: managedDatabaseBindings.targetType,
        targetResourceId: managedDatabaseBindings.targetResourceId,
        desiredState: managedDatabaseBindings.desiredState,
        status: managedDatabaseBindings.status,
      })
      .from(managedDatabaseBindings),
    db
      .select({
        id: managedDatabaseBindingPlacements.id,
        bindingId: managedDatabaseBindingPlacements.bindingId,
        availabilityPlacementId: managedDatabaseBindingPlacements.availabilityPlacementId,
        sourceNodeId: managedDatabaseBindingPlacements.nodeId,
        desiredState: managedDatabaseBindingPlacements.desiredState,
        status: managedDatabaseBindingPlacements.status,
      })
      .from(managedDatabaseBindingPlacements),
    db
      .select({
        mode: dockerAvailabilityPolicies.mode,
        status: dockerAvailabilityPolicies.status,
        resourceKind: dockerAvailabilityPolicies.resourceKind,
        sourceNodeId: dockerAvailabilityPolicies.sourceNodeId,
        containerName: dockerAvailabilityPolicies.containerName,
        deploymentId: dockerAvailabilityPolicies.deploymentId,
        composeProjectId: dockerAvailabilityPolicies.composeProjectId,
      })
      .from(dockerAvailabilityPolicies),
    db.select({ id: nodes.id, certificateFingerprint: nodes.certificateFingerprint }).from(nodes),
  ]);
  const fingerprints = new Map(
    identities
      .filter(({ certificateFingerprint }) => Boolean(certificateFingerprint))
      .map(({ id, certificateFingerprint }) => [id, certificateFingerprint!])
  );
  const activeAvailabilityPolicies = availabilityPolicies.filter(
    ({ mode, status }) => mode !== 'single' && status !== 'disabling'
  );
  const availabilityManagedBindingIds = new Set(
    bindings
      .filter((binding) =>
        activeAvailabilityPolicies.some((policy) => {
          if (binding.targetType === 'container') {
            return (
              policy.resourceKind === 'container' &&
              policy.sourceNodeId === binding.sourceNodeId &&
              policy.containerName === binding.targetResourceId
            );
          }
          if (binding.targetType === 'deployment') {
            return policy.resourceKind === 'deployment' && policy.deploymentId === binding.targetResourceId;
          }
          return (
            policy.resourceKind === 'compose' && policy.composeProjectId === binding.targetResourceId.split(':', 1)[0]
          );
        })
      )
      .map(({ id }) => id)
  );
  const parentBindings = new Map(bindings.map((binding) => [binding.id, binding]));
  const relayBindings = [
    ...bindings.filter(({ id }) => !availabilityManagedBindingIds.has(id)),
    ...bindingPlacements.flatMap((placement) => {
      if (!placement.availabilityPlacementId) return [];
      const parent = parentBindings.get(placement.bindingId);
      return parent
        ? [
            {
              id: placement.id,
              managedDatabaseId: parent.managedDatabaseId,
              sourceNodeId: placement.sourceNodeId,
              desiredState: placement.desiredState,
              status: placement.status,
            },
          ]
        : [];
    }),
  ];

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    let changed = false;
    const existingEndpoints = await tx
      .select()
      .from(relayEndpoints)
      .where(eq(relayEndpoints.ownerKind, 'managed_database'));
    const databaseIds = new Set(databases.filter(({ nodeId }) => fingerprints.has(nodeId)).map(({ id }) => id));
    for (const endpoint of existingEndpoints) {
      if (databaseIds.has(endpoint.ownerId)) continue;
      await tx.delete(relayEndpoints).where(eq(relayEndpoints.id, endpoint.id));
      changed = true;
    }
    for (const database of databases) {
      const certificateSha256 = fingerprints.get(database.nodeId);
      if (!certificateSha256) continue;
      const status = database.status === 'ready' || database.status === 'updating' ? 'active' : 'inactive';
      const current = existingEndpoints.find(({ ownerId }) => ownerId === database.id);
      if (!current) {
        await tx.insert(relayEndpoints).values({
          ownerKind: 'managed_database',
          ownerId: database.id,
          subjectKind: 'daemon',
          subjectId: database.nodeId,
          certificateSha256,
          status,
        });
        changed = true;
      } else if (
        current.subjectId !== database.nodeId ||
        current.certificateSha256 !== certificateSha256 ||
        current.status !== status
      ) {
        await tx
          .update(relayEndpoints)
          .set({
            subjectId: database.nodeId,
            certificateSha256,
            status,
            generation: current.generation + 1,
            updatedAt: new Date(),
          })
          .where(eq(relayEndpoints.id, current.id));
        changed = true;
      }
    }

    const endpoints = await tx.select().from(relayEndpoints).where(eq(relayEndpoints.ownerKind, 'managed_database'));
    const endpointByDatabase = new Map(endpoints.map((endpoint) => [endpoint.ownerId, endpoint]));
    const existingRoutes = await tx
      .select()
      .from(relayRoutes)
      .where(eq(relayRoutes.ownerKind, 'managed_database_binding'));
    // A link keeps its route from creation until it is deleted. Creation starts the workload with
    // the link before the link is 'ready', and a failed reconcile marks a working link 'error';
    // dropping the route in either state closes the listener the workload connects through.
    const desiredBindings = relayBindings.filter(
      ({ desiredState, status, managedDatabaseId, sourceNodeId }) =>
        desiredState === 'active' &&
        status !== 'deleting' &&
        endpointByDatabase.has(managedDatabaseId) &&
        fingerprints.has(sourceNodeId)
    );
    const desiredBindingIds = new Set(desiredBindings.map(({ id }) => id));
    for (const route of existingRoutes) {
      if (desiredBindingIds.has(route.ownerId)) continue;
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
    }
    for (const binding of desiredBindings) {
      const endpoint = endpointByDatabase.get(binding.managedDatabaseId)!;
      const sourceCertificateSha256 = fingerprints.get(binding.sourceNodeId)!;
      const current = existingRoutes.find(({ ownerId }) => ownerId === binding.id);
      if (!current) {
        await tx.insert(relayRoutes).values({
          ownerKind: 'managed_database_binding',
          ownerId: binding.id,
          sourceKind: 'daemon',
          sourceId: binding.sourceNodeId,
          sourceCertificateSha256,
          targetEndpointId: endpoint.id,
          maxFrameBytes: RELAY_MAX_FRAME_BYTES,
        });
        changed = true;
      } else if (
        current.sourceId !== binding.sourceNodeId ||
        current.sourceCertificateSha256 !== sourceCertificateSha256 ||
        current.targetEndpointId !== endpoint.id
      ) {
        await tx
          .update(relayRoutes)
          .set({
            sourceId: binding.sourceNodeId,
            sourceCertificateSha256,
            targetEndpointId: endpoint.id,
            generation: current.generation + 1,
            updatedAt: new Date(),
          })
          .where(eq(relayRoutes.id, current.id));
        changed = true;
      }
    }
    if (changed) await bumpRelayPolicyRevision(tx);
  });
}

/**
 * Removes storage link routes whose link no longer exists. Storage links create and revoke their
 * routes inline; a crash between the two (or a failed revoke) would otherwise leave a route that
 * lets the source node reach the storage without a link.
 */
export async function reconcileManagedStorageRelayPolicy(db: DrizzleClient): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-policy-reconciliation'))`);
    // Routes first: a link row is committed before its route is created, so every link whose
    // route this read sees is visible to the read below.
    const routes = await tx
      .select({ id: relayRoutes.id, ownerId: relayRoutes.ownerId })
      .from(relayRoutes)
      .where(eq(relayRoutes.ownerKind, 'managed_storage_binding'));
    if (routes.length === 0) return;
    const bindings = await tx.select({ id: managedStorageBindings.id }).from(managedStorageBindings);
    const bindingIds = new Set(bindings.map(({ id }) => id));
    let changed = false;
    for (const route of routes) {
      if (bindingIds.has(route.ownerId)) continue;
      await tx.delete(relayRoutes).where(eq(relayRoutes.id, route.id));
      changed = true;
    }
    if (changed) await bumpRelayPolicyRevision(tx);
  });
}
