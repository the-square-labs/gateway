import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  proxyAdditionalSecureLinks,
  proxyHosts,
  relayAssignmentSourceProbes,
  relayEndpointAssignmentGenerations,
  relayEndpointAssignments,
  relayEndpoints,
  relayInstances,
  relayPoolUpdateRuns,
  relayPoolUpdateSteps,
  relayRoutes,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { GeneralSettingsService, RelayAssignmentSpread } from '@/modules/settings/general-settings.service.js';
import type { EventBusService } from './event-bus.service.js';
import type { RelayPolicyService } from './relay-policy.service.js';

type RelayInstanceRow = typeof relayInstances.$inferSelect;

function rendezvousScore(endpointId: string, instance: RelayInstanceRow): bigint {
  const digest = createHash('sha256').update(`${endpointId}:${instance.id}`).digest();
  const raw = digest.readBigUInt64BE(0);
  const pressure = BigInt(Math.max(0, Math.min(99, instance.health?.pressurePercent ?? 0)));
  return raw * (100n - pressure);
}

function chooseCandidates(endpointId: string, instances: RelayInstanceRow[], desiredCount: number) {
  const ranked = instances
    .filter(({ state }) => state === 'ready')
    .sort((left, right) => {
      const delta = rendezvousScore(endpointId, right) - rendezvousScore(endpointId, left);
      return delta > 0n ? 1 : delta < 0n ? -1 : left.id.localeCompare(right.id);
    });
  const selected: RelayInstanceRow[] = [];
  const faultDomains = new Set<string>();
  for (const instance of ranked) {
    if (faultDomains.has(instance.faultDomainId)) continue;
    faultDomains.add(instance.faultDomainId);
    selected.push(instance);
    if (selected.length >= desiredCount) break;
  }
  return selected;
}

function isEnrolledRelayInstance(instance: RelayInstanceRow): boolean {
  return instance.kind === 'local' || Boolean(instance.certificateIdentity && instance.certificateFingerprint);
}

function effectiveCount(spread: RelayAssignmentSpread, readyCount: number): number {
  return Math.min(readyCount, spread.mode === 'all' ? readyCount : spread.count);
}

function sameAssignmentSet(assignments: Array<{ relayInstanceId: string }>, instanceIds: string[]): boolean {
  return (
    assignments.length === instanceIds.length &&
    assignments.every(({ relayInstanceId }) => instanceIds.includes(relayInstanceId))
  );
}

export class RelayPoolService {
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly db: DrizzleClient,
    private readonly policy: RelayPolicyService,
    private readonly events: EventBusService,
    private readonly audit: AuditService,
    private readonly settings: GeneralSettingsService
  ) {}

  startReconciliation(): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      void this.retireDrainedGenerations().catch(() => undefined);
    }, 5_000);
    this.reconciliationTimer.unref();
  }

  async retireDrainedGenerations(): Promise<number> {
    const generations = await this.db
      .select()
      .from(relayEndpointAssignmentGenerations)
      .where(eq(relayEndpointAssignmentGenerations.state, 'draining'));
    let retired = 0;
    for (const generation of generations) {
      const assignments = await this.db
        .select({ health: relayInstances.health })
        .from(relayEndpointAssignments)
        .innerJoin(relayInstances, eq(relayEndpointAssignments.relayInstanceId, relayInstances.id))
        .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id));
      if (!assignments.length) continue;
      const fullyObservedAndIdle = assignments.every(({ health }) => {
        if (!Array.isArray(health?.assignmentTunnels)) return false;
        return !health.assignmentTunnels.some(
          (count) =>
            count.endpointId === generation.endpointId &&
            count.assignmentGeneration === generation.generation &&
            count.activeTunnels > 0
        );
      });
      if (!fullyObservedAndIdle) continue;
      const result = await this.db
        .update(relayEndpointAssignmentGenerations)
        .set({ state: 'retired', retiredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.id, generation.id),
            eq(relayEndpointAssignmentGenerations.state, 'draining')
          )
        )
        .returning({ id: relayEndpointAssignmentGenerations.id });
      retired += result.length;
    }
    if (retired > 0) {
      await this.policy.reconcileAndSync();
      this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'generations_retired' });
    }
    return retired;
  }

  async getSnapshot() {
    const [persistedInstances, endpoints, generations, assignments, generalSettings] = await Promise.all([
      this.db.select().from(relayInstances).where(eq(relayInstances.poolId, 'system')),
      this.db.select().from(relayEndpoints).where(eq(relayEndpoints.status, 'active')),
      this.db
        .select()
        .from(relayEndpointAssignmentGenerations)
        .where(inArray(relayEndpointAssignmentGenerations.state, ['active', 'staging', 'draining'])),
      this.db.select().from(relayEndpointAssignments),
      this.settings.getConfig(),
    ]);
    const instances = persistedInstances.filter(isEnrolledRelayInstance);
    const effectiveSpreads = await this.resolveEffectiveSpreads(endpoints, generalSettings.relay.assignmentSpread);
    const assignmentsByGeneration = new Map<string, typeof assignments>();
    for (const assignment of assignments) {
      const current = assignmentsByGeneration.get(assignment.assignmentGenerationId) ?? [];
      current.push(assignment);
      assignmentsByGeneration.set(assignment.assignmentGenerationId, current);
    }
    const activeByEndpoint = new Map(
      generations.filter(({ state }) => state === 'active').map((generation) => [generation.endpointId, generation])
    );
    const stagingByEndpoint = new Map(
      generations.filter(({ state }) => state === 'staging').map((generation) => [generation.endpointId, generation])
    );
    const [latestUpdateRun] = await this.db
      .select()
      .from(relayPoolUpdateRuns)
      .where(eq(relayPoolUpdateRuns.poolId, 'system'))
      .orderBy(desc(relayPoolUpdateRuns.startedAt))
      .limit(1);
    const updateRun = latestUpdateRun?.state === 'complete' ? undefined : latestUpdateRun;
    const updateSteps = updateRun
      ? await this.db
          .select()
          .from(relayPoolUpdateSteps)
          .where(eq(relayPoolUpdateSteps.runId, updateRun.id))
          .orderBy(relayPoolUpdateSteps.sequence)
      : [];
    const updateStepByInstance = new Map(updateSteps.map((step) => [step.relayInstanceId, step]));
    const readyFaultDomains = new Set(
      instances.filter(({ state }) => state === 'ready').map(({ faultDomainId }) => faultDomainId)
    );
    const rebalanceAvailable =
      readyFaultDomains.size > 0 &&
      endpoints.some((endpoint) => {
        if (endpoint.ownerKind === 'internal_registry') return false;
        const spread = effectiveSpreads.get(endpoint.id) ?? generalSettings.relay.assignmentSpread;
        const selectedIds = chooseCandidates(
          endpoint.id,
          instances,
          effectiveCount(spread, readyFaultDomains.size)
        ).map(({ id }) => id);
        const active = activeByEndpoint.get(endpoint.id);
        return !active || !sameAssignmentSet(assignmentsByGeneration.get(active.id) ?? [], selectedIds);
      });
    const activeTunnels = instances.reduce((sum, instance) => sum + (instance.health?.activeTunnels ?? 0), 0);
    const registeredEndpoints = instances.reduce(
      (sum, instance) => sum + (instance.health?.registeredEndpoints ?? 0),
      0
    );
    const worstPressure = Math.max(0, ...instances.map((instance) => instance.health?.pressurePercent ?? 0));
    const unavailable =
      instances.length === 0 || instances.every(({ state }) => !['ready', 'draining'].includes(state));
    const degraded = !unavailable && instances.some(({ state }) => ['offline', 'error'].includes(state));
    return {
      poolId: 'system',
      state: unavailable
        ? 'unavailable'
        : generations.some(({ state }) => state === 'staging')
          ? 'rebalancing'
          : degraded
            ? 'degraded'
            : rebalanceAvailable
              ? 'rebalance_available'
              : 'healthy',
      rebalanceAvailable,
      activeTunnels,
      registeredEndpoints,
      worstPressurePercent: worstPressure,
      endpointCount: endpoints.length,
      instances: instances.map((instance) => {
        let activeAssignments = 0;
        for (const generation of activeByEndpoint.values()) {
          for (const assignment of assignmentsByGeneration.get(generation.id) ?? []) {
            if (assignment.relayInstanceId !== instance.id) continue;
            activeAssignments += 1;
          }
        }
        return {
          ...instance,
          activeAssignments,
          updateStep: updateStepByInstance.get(instance.id) ?? null,
        };
      }),
      staging: [...stagingByEndpoint.values()],
      update: updateRun
        ? { state: updateRun.state, targetVersion: updateRun.targetArtifact.version, error: updateRun.terminalError }
        : null,
    };
  }

  private async resolveEffectiveSpreads(
    endpoints: Array<Pick<typeof relayEndpoints.$inferSelect, 'id' | 'ownerKind' | 'ownerId'>>,
    globalSpread: RelayAssignmentSpread
  ): Promise<Map<string, RelayAssignmentSpread>> {
    const result = new Map(endpoints.map(({ id }) => [id, globalSpread]));
    const proxyOwnerIds = endpoints
      .filter(({ ownerKind }) => ownerKind === 'proxy_host_secure_link')
      .map(({ ownerId }) => ownerId);
    if (!proxyOwnerIds.length) return result;

    const [directHosts, additionalLinks] = await Promise.all([
      this.db
        .select({
          ownerId: proxyHosts.id,
          mode: proxyHosts.relaySpreadMode,
          count: proxyHosts.relaySpreadCount,
        })
        .from(proxyHosts)
        .where(inArray(proxyHosts.id, proxyOwnerIds)),
      this.db
        .select({
          ownerId: proxyAdditionalSecureLinks.id,
          mode: proxyHosts.relaySpreadMode,
          count: proxyHosts.relaySpreadCount,
        })
        .from(proxyAdditionalSecureLinks)
        .innerJoin(proxyHosts, eq(proxyAdditionalSecureLinks.proxyHostId, proxyHosts.id))
        .where(inArray(proxyAdditionalSecureLinks.id, proxyOwnerIds)),
    ]);
    const byOwner = new Map([...directHosts, ...additionalLinks].map((row) => [row.ownerId, row]));
    for (const endpoint of endpoints) {
      if (endpoint.ownerKind !== 'proxy_host_secure_link') continue;
      const override = byOwner.get(endpoint.ownerId);
      if (!override || override.mode === 'inherit') continue;
      result.set(
        endpoint.id,
        override.mode === 'all'
          ? { mode: 'all' }
          : {
              mode: 'fixed',
              count: override.count ?? (globalSpread.mode === 'fixed' ? globalSpread.count : 2),
            }
      );
    }
    return result;
  }

  async refreshRemotePolicies(): Promise<void> {
    const instances = await this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining'])
        )
      );
    await Promise.allSettled(
      instances.flatMap(({ nodeId }) => (nodeId ? [this.policy.syncRemoteInstancePolicy(nodeId)] : []))
    );
    await this.policy.finalizePolicySigningKeyRotation();
  }

  async ensureLegacyCompatibleAssignment(endpointId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-endpoint-assignment:${endpointId}`}))`);
      const [existing] = await tx
        .select({ id: relayEndpointAssignmentGenerations.id })
        .from(relayEndpointAssignmentGenerations)
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, endpointId),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        )
        .limit(1);
      if (existing) return;
      const [local] = await tx
        .select()
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.kind, 'local')))
        .limit(1);
      if (!local) throw new Error('Local relay instance is unavailable');
      const [generation] = await tx
        .insert(relayEndpointAssignmentGenerations)
        .values({ endpointId, generation: 1, state: 'active', desiredRedundancy: 1, activatedAt: new Date() })
        .returning();
      await tx.insert(relayEndpointAssignments).values({
        assignmentGenerationId: generation.id,
        relayInstanceId: local.id,
        role: 'active',
        targetRegistrationState: 'ready',
        targetRegisteredAt: new Date(),
      });
    });
  }

  async stageRebalance(userId: string, options: { endpointIds?: string[]; allowNoop?: boolean } = {}) {
    const endpointFilter = options.endpointIds?.length
      ? inArray(relayEndpoints.id, options.endpointIds)
      : eq(relayEndpoints.status, 'active');
    const endpoints = await this.db
      .select()
      .from(relayEndpoints)
      .where(and(eq(relayEndpoints.status, 'active'), endpointFilter));
    const globalSpread = (await this.settings.getConfig()).relay.assignmentSpread;
    const effectiveSpreads = await this.resolveEffectiveSpreads(endpoints, globalSpread);
    const staged = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gateway-relay-pool-rebalance'))`);
      const readyInstances = await tx
        .select()
        .from(relayInstances)
        .where(and(eq(relayInstances.poolId, 'system'), eq(relayInstances.state, 'ready')));
      const readyFaultDomains = new Set(readyInstances.map(({ faultDomainId }) => faultDomainId)).size;
      if (readyFaultDomains < 1) {
        throw new AppError(409, 'RELAY_CAPACITY_UNAVAILABLE', 'At least one ready physical relay host is required');
      }
      const created: Array<{ id: string; endpointId: string; generation: number; instanceIds: string[] }> = [];
      for (const endpoint of endpoints) {
        if (endpoint.ownerKind === 'internal_registry') continue;
        const [staging] = await tx
          .select({ id: relayEndpointAssignmentGenerations.id })
          .from(relayEndpointAssignmentGenerations)
          .where(
            and(
              eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
              eq(relayEndpointAssignmentGenerations.state, 'staging')
            )
          )
          .limit(1);
        if (staging) continue;
        const [active] = await tx
          .select()
          .from(relayEndpointAssignmentGenerations)
          .where(
            and(
              eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id),
              eq(relayEndpointAssignmentGenerations.state, 'active')
            )
          )
          .limit(1);
        const activeAssignments = active
          ? await tx
              .select()
              .from(relayEndpointAssignments)
              .where(eq(relayEndpointAssignments.assignmentGenerationId, active.id))
          : [];
        const spread = effectiveSpreads.get(endpoint.id) ?? globalSpread;
        const selected = chooseCandidates(endpoint.id, readyInstances, effectiveCount(spread, readyFaultDomains));
        const selectedIds = selected.map(({ id }) => id);
        if (!selectedIds.length || sameAssignmentSet(activeAssignments, selectedIds)) continue;
        const [latest] = await tx
          .select({ generation: relayEndpointAssignmentGenerations.generation })
          .from(relayEndpointAssignmentGenerations)
          .where(eq(relayEndpointAssignmentGenerations.endpointId, endpoint.id))
          .orderBy(desc(relayEndpointAssignmentGenerations.generation))
          .limit(1);
        const generationNumber = (latest?.generation ?? 0) + 1;
        const [generation] = await tx
          .insert(relayEndpointAssignmentGenerations)
          .values({
            endpointId: endpoint.id,
            generation: generationNumber,
            state: 'staging',
            desiredRedundancy: selectedIds.length,
          })
          .returning();
        await tx.insert(relayEndpointAssignments).values(
          selectedIds.map((relayInstanceId) => ({
            assignmentGenerationId: generation.id,
            relayInstanceId,
            role: 'active' as const,
          }))
        );
        const routes = await tx.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, endpoint.id));
        if (routes.length) {
          await tx.insert(relayAssignmentSourceProbes).values(
            routes.flatMap((route) =>
              selectedIds.map((relayInstanceId) => ({
                assignmentGenerationId: generation.id,
                relayInstanceId,
                sourceKind: route.sourceKind,
                sourceId: route.sourceId,
                certificateFingerprint: route.sourceCertificateSha256,
              }))
            )
          );
        }
        created.push({
          id: generation.id,
          endpointId: endpoint.id,
          generation: generationNumber,
          instanceIds: selectedIds,
        });
      }
      return created;
    });
    if (!staged.length) {
      if (options.allowNoop) return [];
      throw new AppError(409, 'RELAY_REBALANCE_NOT_NEEDED', 'Relay assignments are already balanced');
    }
    // Both local and remote Relays must authorize the staged generation before
    // endpoint/source probes receive grants for it. Remote snapshots are sent
    // below through daemon control; apply the local snapshot explicitly first.
    await this.policy.syncSnapshot();
    const remoteNodes = await this.db
      .select({ nodeId: relayInstances.nodeId })
      .from(relayInstances)
      .where(
        and(
          eq(relayInstances.poolId, 'system'),
          eq(relayInstances.kind, 'remote'),
          inArray(relayInstances.state, ['synchronizing', 'ready', 'draining'])
        )
      );
    await Promise.allSettled(
      remoteNodes.flatMap(({ nodeId }) => (nodeId ? [this.policy.syncRemoteInstancePolicy(nodeId)] : []))
    );
    await Promise.all(staged.map((generation) => this.prepareStagedGeneration(generation)));
    await this.audit.log({
      userId,
      action: 'relay.pool.rebalance.stage',
      resourceType: 'relay_pool',
      resourceId: 'system',
      details: { generations: staged, endpointIds: options.endpointIds ?? null },
    });
    this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'rebalance_staged' });
    return staged;
  }

  async stageProxyWorkloadRebalance(proxyHostId: string, userId: string) {
    const additional = await this.db
      .select({ id: proxyAdditionalSecureLinks.id })
      .from(proxyAdditionalSecureLinks)
      .where(eq(proxyAdditionalSecureLinks.proxyHostId, proxyHostId));
    const ownerIds = [proxyHostId, ...additional.map(({ id }) => id)];
    const endpoints = await this.db
      .select({ id: relayEndpoints.id })
      .from(relayEndpoints)
      .where(
        and(
          eq(relayEndpoints.ownerKind, 'proxy_host_secure_link'),
          inArray(relayEndpoints.ownerId, ownerIds),
          eq(relayEndpoints.status, 'active')
        )
      );
    if (!endpoints.length) return [];
    return this.stageRebalance(userId, {
      endpointIds: endpoints.map(({ id }) => id),
      allowNoop: true,
    });
  }

  async acknowledgeTarget(generationId: string, relayInstanceId: string, ready: boolean, error?: string) {
    await this.db
      .update(relayEndpointAssignments)
      .set({
        targetRegistrationState: ready ? 'ready' : 'failed',
        targetRegisteredAt: ready ? new Date() : null,
        targetRegistrationError: ready ? null : error?.slice(0, 1000) || 'target registration failed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(relayEndpointAssignments.assignmentGenerationId, generationId),
          eq(relayEndpointAssignments.relayInstanceId, relayInstanceId)
        )
      );
    return this.tryActivate(generationId);
  }

  async acknowledgeProbe(probeId: string, ready: boolean, error?: string) {
    const [probe] = await this.db
      .update(relayAssignmentSourceProbes)
      .set({
        state: ready ? 'ready' : 'failed',
        acknowledgedAt: ready ? new Date() : null,
        error: ready ? null : error?.slice(0, 1000) || 'source probe failed',
        updatedAt: new Date(),
      })
      .where(eq(relayAssignmentSourceProbes.id, probeId))
      .returning({ generationId: relayAssignmentSourceProbes.assignmentGenerationId });
    return probe ? this.tryActivate(probe.generationId) : false;
  }

  async drainInstance(instanceId: string, userId: string, enabled = true) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind === 'local')
      throw new AppError(409, 'LOCAL_RELAY_DRAIN_UNSUPPORTED', 'Use pool maintenance for local relay');
    if (!instance.nodeId) throw new AppError(409, 'RELAY_INSTANCE_UNENROLLED', 'Relay instance is not enrolled');
    await this.policy.setRemoteInstanceDrain(instance.nodeId, enabled);
    await this.db
      .update(relayInstances)
      .set({ state: enabled ? 'draining' : 'ready', updatedAt: new Date() })
      .where(eq(relayInstances.id, instance.id));
    await this.policy.reconcileAndSync();
    await this.audit.log({
      userId,
      action: enabled ? 'relay.instance.drain' : 'relay.instance.resume',
      resourceType: 'relay_instance',
      resourceId: instance.id,
      details: {},
    });
    this.events.publish('system.relay.health.changed', { poolId: instance.poolId, instanceId: instance.id });
  }

  async forceDisconnectInstance(instanceId: string, userId: string) {
    const [instance] = await this.db.select().from(relayInstances).where(eq(relayInstances.id, instanceId)).limit(1);
    if (!instance) throw new AppError(404, 'RELAY_INSTANCE_NOT_FOUND', 'Relay instance not found');
    if (instance.kind === 'local')
      throw new AppError(409, 'LOCAL_RELAY_DRAIN_UNSUPPORTED', 'Use pool maintenance for local relay');
    if (!instance.nodeId) throw new AppError(409, 'RELAY_INSTANCE_UNENROLLED', 'Relay instance is not enrolled');
    if (instance.state !== 'draining') {
      throw new AppError(409, 'RELAY_INSTANCE_NOT_DRAINING', 'Relay instance must be draining first');
    }
    await this.policy.setRemoteInstanceDrain(instance.nodeId, true, true);
    await this.audit.log({
      userId,
      action: 'relay.instance.force_disconnect',
      resourceType: 'relay_instance',
      resourceId: instance.id,
      details: { activeTunnels: instance.health?.activeTunnels ?? 0 },
    });
    this.events.publish('system.relay.health.changed', {
      poolId: instance.poolId,
      instanceId: instance.id,
      action: 'force_disconnect',
    });
  }

  private async tryActivate(generationId: string): Promise<boolean> {
    const activated = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`relay-assignment-generation:${generationId}`}))`);
      const [generation] = await tx
        .select()
        .from(relayEndpointAssignmentGenerations)
        .where(eq(relayEndpointAssignmentGenerations.id, generationId))
        .limit(1);
      if (!generation || generation.state !== 'staging') return false;
      const [assignments, probes] = await Promise.all([
        tx
          .select()
          .from(relayEndpointAssignments)
          .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id)),
        tx
          .select()
          .from(relayAssignmentSourceProbes)
          .where(eq(relayAssignmentSourceProbes.assignmentGenerationId, generation.id)),
      ]);
      if (
        assignments.some(({ targetRegistrationState }) => targetRegistrationState === 'failed') ||
        probes.some(({ state }) => state === 'failed')
      ) {
        await tx
          .update(relayEndpointAssignmentGenerations)
          .set({
            state: 'failed',
            activationError: 'Target registration or source reachability probe failed',
            updatedAt: new Date(),
          })
          .where(eq(relayEndpointAssignmentGenerations.id, generation.id));
        return false;
      }
      if (
        assignments.length !== generation.desiredRedundancy ||
        assignments.some(({ targetRegistrationState }) => targetRegistrationState !== 'ready') ||
        probes.some(({ state }) => state !== 'ready')
      ) {
        return false;
      }
      await tx
        .update(relayEndpointAssignmentGenerations)
        .set({ state: 'draining', drainStartedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(relayEndpointAssignmentGenerations.endpointId, generation.endpointId),
            eq(relayEndpointAssignmentGenerations.state, 'active')
          )
        );
      await tx
        .update(relayEndpointAssignmentGenerations)
        .set({ state: 'active', activatedAt: new Date(), activationError: null, updatedAt: new Date() })
        .where(eq(relayEndpointAssignmentGenerations.id, generation.id));
      await tx
        .update(relayEndpoints)
        .set({ activeAssignmentGeneration: generation.generation, updatedAt: new Date() })
        .where(eq(relayEndpoints.id, generation.endpointId));
      return true;
    });
    if (activated) {
      await this.policy.reconcileAndSync();
      this.events.publish('system.relay.health.changed', { poolId: 'system', action: 'rebalance_activated' });
    }
    return activated;
  }

  private async prepareStagedGeneration(generation: {
    id: string;
    endpointId: string;
    generation: number;
    instanceIds: string[];
  }): Promise<void> {
    const [[endpoint], routes, assignments, probes] = await Promise.all([
      this.db.select().from(relayEndpoints).where(eq(relayEndpoints.id, generation.endpointId)).limit(1),
      this.db.select().from(relayRoutes).where(eq(relayRoutes.targetEndpointId, generation.endpointId)),
      this.db
        .select({ id: relayEndpointAssignments.id, relayInstanceId: relayEndpointAssignments.relayInstanceId })
        .from(relayEndpointAssignments)
        .where(eq(relayEndpointAssignments.assignmentGenerationId, generation.id)),
      this.db
        .select()
        .from(relayAssignmentSourceProbes)
        .where(eq(relayAssignmentSourceProbes.assignmentGenerationId, generation.id)),
    ]);
    if (!endpoint) throw new Error(`Relay endpoint ${generation.endpointId} disappeared during rebalance`);
    const daemonNodeIds = [
      endpoint.subjectId,
      ...routes.filter(({ sourceKind }) => sourceKind === 'daemon').map(({ sourceId }) => sourceId),
    ];
    await Promise.all([...new Set(daemonNodeIds)].map((nodeId) => this.policy.syncNodeGrants(nodeId)));

    const bundleCache = new Map<string, Awaited<ReturnType<RelayPolicyService['getNodeGrantBundle']>>>();
    const getBundle = async (nodeId: string) => {
      let bundle = bundleCache.get(nodeId);
      if (!bundle) {
        bundle = await this.policy.getNodeGrantBundle(nodeId);
        bundleCache.set(nodeId, bundle);
      }
      return bundle;
    };
    const targetBundle = await getBundle(endpoint.subjectId);
    const targetGrant = targetBundle.grants.find(
      ({ role, endpointId }) => role === 'endpoint' && endpointId === generation.endpointId
    );
    for (const assignment of assignments) {
      const candidate = targetGrant?.candidates?.find(
        ({ relayInstanceId, assignmentGeneration }) =>
          relayInstanceId === assignment.relayInstanceId && assignmentGeneration === String(generation.generation)
      );
      if (!candidate) {
        await this.acknowledgeTarget(
          generation.id,
          assignment.relayInstanceId,
          false,
          'Pool candidate grant is unavailable'
        );
        continue;
      }
      try {
        await this.policy.probeRelayCandidate(endpoint.subjectId, {
          probeId: assignment.id,
          role: 'target',
          endpointId: generation.endpointId,
          assignmentGeneration: String(generation.generation),
          candidate,
        });
        await this.acknowledgeTarget(generation.id, assignment.relayInstanceId, true);
      } catch (error) {
        await this.acknowledgeTarget(
          generation.id,
          assignment.relayInstanceId,
          false,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    for (const probe of probes) {
      const route = routes.find(
        ({ sourceKind, sourceId }) => sourceKind === probe.sourceKind && sourceId === probe.sourceId
      );
      if (!route) {
        await this.acknowledgeProbe(probe.id, false, 'Relay source route is unavailable');
        continue;
      }
      if (route.sourceKind === 'gateway') {
        try {
          await this.policy.probeGatewayRelayCandidate(
            route.id,
            probe.certificateFingerprint,
            probe.relayInstanceId,
            String(generation.generation)
          );
          await this.acknowledgeProbe(probe.id, true);
        } catch (error) {
          await this.acknowledgeProbe(probe.id, false, error instanceof Error ? error.message : String(error));
        }
        continue;
      }
      if (route.sourceKind !== 'daemon') {
        await this.acknowledgeProbe(probe.id, false, `Unsupported relay source kind ${route.sourceKind}`);
        continue;
      }
      const sourceBundle = await getBundle(route.sourceId);
      const sourceGrant = sourceBundle.grants.find(({ role, routeId }) => role === 'connect' && routeId === route.id);
      const candidate = sourceGrant?.candidates?.find(
        ({ relayInstanceId, assignmentGeneration }) =>
          relayInstanceId === probe.relayInstanceId && assignmentGeneration === String(generation.generation)
      );
      if (!candidate) {
        await this.acknowledgeProbe(probe.id, false, 'Pool candidate grant is unavailable');
        continue;
      }
      try {
        await this.policy.probeRelayCandidate(route.sourceId, {
          probeId: probe.id,
          role: 'source',
          endpointId: generation.endpointId,
          routeId: route.id,
          assignmentGeneration: String(generation.generation),
          candidate,
        });
        await this.acknowledgeProbe(probe.id, true);
      } catch (error) {
        await this.acknowledgeProbe(probe.id, false, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

export const relayPoolInternals = { chooseCandidates, isEnrolledRelayInstance };
