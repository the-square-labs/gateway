import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityPolicies,
  dockerComposeOperations,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerContainerFolderAssignments,
} from '@/db/schema/index.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_CONTAINER_NUMBER_LABEL = 'com.docker.compose.container-number';
const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';
const COMPOSE_NETWORK_LABEL = 'com.docker.compose.network';
const COMPOSE_SIDECAR_LABEL = 'wiolett.gateway.compose.sidecar';
const GATEWAY_COMPOSE_MANAGED_LABEL = 'wiolett.gateway.compose.managed';
const COMPOSE_ONEOFF_LABEL = 'com.docker.compose.oneoff';

type DockerResource = Record<string, unknown>;
type ComposeResourceKind = 'container' | 'volume' | 'network';

export interface ComposeProjectObservation {
  name: string;
  observedFingerprint: string;
  gatewayManaged?: boolean;
}

export interface ComposeDiscoveryChange {
  action: 'discovered' | 'observed' | 'missing' | 'removed';
  projectId: string;
  projectName: string;
}

type ExistingComposeProject = {
  id: string;
  name: string;
  managementState: 'external' | 'managed';
  desiredState?: string;
  observedFingerprint?: string | null;
  status?: string;
  availability?: string;
  preserveWhenMissing?: boolean;
};

function labelsFor(resource: DockerResource): Record<string, string> {
  const labels = resource.labels ?? resource.Labels;
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function labelValue(labels: Record<string, string>, key: string): string | null {
  const value = labels[key]?.trim();
  return value ? value : null;
}

function resourceName(resource: DockerResource): string {
  return String(resource.name ?? resource.Name ?? resource.id ?? resource.Id ?? '').replace(/^\/+/, '');
}

function projectNameFor(resource: DockerResource): string | null {
  return labelValue(labelsFor(resource), COMPOSE_PROJECT_LABEL);
}

export function isComposeOwnedContainer(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return projectNameFor(resource) !== null || labels[COMPOSE_SIDECAR_LABEL] === 'true';
}

export function isComposeOwnedVolume(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return labelValue(labels, COMPOSE_PROJECT_LABEL) !== null && labelValue(labels, COMPOSE_VOLUME_LABEL) !== null;
}

export function isComposeOwnedNetwork(resource: DockerResource): boolean {
  const labels = labelsFor(resource);
  return labelValue(labels, COMPOSE_PROJECT_LABEL) !== null && labelValue(labels, COMPOSE_NETWORK_LABEL) !== null;
}

function fingerprintEntry(kind: ComposeResourceKind, resource: DockerResource): [string, string] | null {
  const labels = labelsFor(resource);
  const project = labelValue(labels, COMPOSE_PROJECT_LABEL);
  if (!project) return null;

  const ownershipLabel =
    kind === 'container'
      ? labelValue(labels, COMPOSE_SERVICE_LABEL)
      : kind === 'volume'
        ? labelValue(labels, COMPOSE_VOLUME_LABEL)
        : labelValue(labels, COMPOSE_NETWORK_LABEL);
  if (kind !== 'container' && !ownershipLabel) return null;

  const identity = [
    kind,
    resourceName(resource),
    ownershipLabel ?? '',
    labelValue(labels, COMPOSE_CONTAINER_NUMBER_LABEL) ?? '',
  ].join(':');
  return [project, identity];
}

export function observeComposeProjects(input: {
  containers?: DockerResource[];
  volumes?: DockerResource[];
  networks?: DockerResource[];
}): ComposeProjectObservation[] {
  const entries = new Map<string, { values: string[]; gatewayManaged: boolean }>();
  const resources: Array<[ComposeResourceKind, DockerResource[] | undefined]> = [
    ['container', input.containers],
    ['volume', input.volumes],
    ['network', input.networks],
  ];

  for (const [kind, rows] of resources) {
    for (const resource of rows ?? []) {
      const entry = fingerprintEntry(kind, resource);
      if (!entry) continue;
      const [project, identity] = entry;
      const labels = labelsFor(resource);
      const projectEntries = entries.get(project) ?? { values: [], gatewayManaged: false };
      projectEntries.values.push(identity);
      projectEntries.gatewayManaged ||= labels[GATEWAY_COMPOSE_MANAGED_LABEL] === 'true';
      entries.set(project, projectEntries);
    }
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => ({
      name,
      observedFingerprint: createHash('sha256')
        .update([...new Set(entry.values)].sort().join('\n'))
        .digest('hex'),
      ...(entry.gatewayManaged ? { gatewayManaged: true } : {}),
    }));
}

/**
 * N-25: per Compose project, the services its containers belong to and those with a running container (sidecars and
 * one-off `run` containers aside).
 */
export function observeComposeServiceStates(
  containers: DockerResource[] = []
): Map<string, { services: Set<string>; running: Set<string> }> {
  const states = new Map<string, { services: Set<string>; running: Set<string> }>();
  for (const container of containers) {
    const labels = labelsFor(container);
    const project = labelValue(labels, COMPOSE_PROJECT_LABEL);
    const service = labelValue(labels, COMPOSE_SERVICE_LABEL);
    if (!project || !service || labels[COMPOSE_SIDECAR_LABEL] === 'true') continue;
    if (String(labels[COMPOSE_ONEOFF_LABEL] ?? '').toLowerCase() === 'true') continue;
    const entry = states.get(project) ?? { services: new Set<string>(), running: new Set<string>() };
    entry.services.add(service);
    if (String(container.state ?? container.State ?? '').toLowerCase() === 'running') entry.running.add(service);
    states.set(project, entry);
  }
  return states;
}

/**
 * The status a managed project that should run shows for what its containers do: every service running, some of
 * them (degraded: partially running), or none (stopped while it should run, which the status page reports as an
 * outage, unlike a stop through Gateway).
 */
export function observedComposeRunStatus(state: { services: Set<string>; running: Set<string> }) {
  if (state.running.size === 0) return 'stopped' as const;
  return state.running.size < state.services.size ? ('degraded' as const) : ('running' as const);
}

export function filterDiscoverableComposeProjects(
  observed: ComposeProjectObservation[],
  existing: ExistingComposeProject[]
): ComposeProjectObservation[] {
  const localManagedNames = new Set(
    existing.filter((project) => project.managementState === 'managed').map((project) => project.name)
  );
  return observed
    .filter((project) => !project.gatewayManaged || localManagedNames.has(project.name))
    .map(({ gatewayManaged: _gatewayManaged, ...project }) => project);
}

export function planExternalComposeProjectReconciliation(
  existing: ExistingComposeProject[],
  observed: ComposeProjectObservation[]
) {
  const observedByName = new Map(observed.map((project) => [project.name, project]));
  const existingByName = new Map(existing.map((project) => [project.name, project]));

  return {
    create: observed.filter((project) => !existingByName.has(project.name)),
    observed: observed.map((project) => ({ project, existing: existingByName.get(project.name) })),
    missingExternal: existing.filter(
      (project) =>
        project.managementState === 'external' && !observedByName.has(project.name) && project.preserveWhenMissing
    ),
    removeMissingExternal: existing.filter(
      (project) =>
        project.managementState === 'external' && !observedByName.has(project.name) && !project.preserveWhenMissing
    ),
  };
}

export async function reconcileExternalComposeProjects(
  db: DrizzleClient,
  nodeId: string,
  input: Parameters<typeof observeComposeProjects>[0],
  observedAt = new Date(),
  onChange?: (change: ComposeDiscoveryChange) => void
): Promise<ComposeProjectObservation[]> {
  const observedProjects = observeComposeProjects(input);
  const existingRows = await db
    .select({
      id: dockerComposeProjects.id,
      name: dockerComposeProjects.name,
      managementState: dockerComposeProjects.managementState,
      desiredState: dockerComposeProjects.desiredState,
      observedFingerprint: dockerComposeProjects.observedFingerprint,
      status: dockerComposeProjects.status,
      availability: dockerComposeProjects.availability,
      folderId: dockerContainerFolderAssignments.folderId,
      folderSortOrder: dockerContainerFolderAssignments.sortOrder,
      hasRevisions: sql<boolean>`exists(
        select 1 from ${dockerComposeRevisions}
        where ${dockerComposeRevisions.projectId} = ${dockerComposeProjects.id}
      )`,
    })
    .from(dockerComposeProjects)
    .leftJoin(
      dockerContainerFolderAssignments,
      and(
        eq(dockerContainerFolderAssignments.nodeId, dockerComposeProjects.nodeId),
        eq(dockerContainerFolderAssignments.resourceType, 'compose'),
        sql`${dockerContainerFolderAssignments.resourceKey} = ${dockerComposeProjects.id}::text`
      )
    )
    .where(eq(dockerComposeProjects.nodeId, nodeId));
  const existing = existingRows.map((project) => ({
    id: project.id,
    name: project.name,
    managementState: project.managementState,
    desiredState: project.desiredState,
    observedFingerprint: project.observedFingerprint,
    status: project.status,
    availability: project.availability,
    preserveWhenMissing: project.hasRevisions || project.folderId !== null || (project.folderSortOrder ?? 0) !== 0,
  }));
  const observed = filterDiscoverableComposeProjects(observedProjects, existing);
  const plan = planExternalComposeProjectReconciliation(existing, observed);

  if (plan.create.length > 0) {
    await db
      .insert(dockerComposeProjects)
      .values(
        plan.create.map((project) => ({
          nodeId,
          name: project.name,
          managementState: 'external' as const,
          desiredState: 'running' as const,
          status: 'discovered' as const,
          availability: 'available' as const,
          observedFingerprint: project.observedFingerprint,
          lastSeenAt: observedAt,
        }))
      )
      .onConflictDoNothing({ target: [dockerComposeProjects.nodeId, dockerComposeProjects.name] });
  }

  for (const { project, existing: current } of plan.observed) {
    const values = {
      observedFingerprint: project.observedFingerprint,
      lastSeenAt: observedAt,
      availability: 'available' as const,
      updatedAt: observedAt,
      ...(current?.managementState === 'external' ? { status: 'discovered' as const } : {}),
    };
    await db
      .update(dockerComposeProjects)
      .set(values)
      .where(and(eq(dockerComposeProjects.nodeId, nodeId), eq(dockerComposeProjects.name, project.name)));
    if (
      current &&
      (current.observedFingerprint !== project.observedFingerprint ||
        current.availability !== 'available' ||
        (current.managementState === 'external' && current.status !== 'discovered'))
    ) {
      onChange?.({ action: 'observed', projectId: current.id, projectName: project.name });
    }
  }

  await reconcileManagedComposeRunStatus(db, nodeId, plan.observed, input.containers, observedAt, onChange);

  if (plan.missingExternal.length > 0) {
    await db
      .update(dockerComposeProjects)
      .set({ status: 'missing', availability: 'unavailable', updatedAt: observedAt })
      .where(
        inArray(
          dockerComposeProjects.id,
          plan.missingExternal.map((project) => project.id)
        )
      );
    for (const project of plan.missingExternal) {
      if (project.status === 'missing' && project.availability === 'unavailable') continue;
      onChange?.({ action: 'missing', projectId: project.id, projectName: project.name });
    }
  }

  if (plan.removeMissingExternal.length > 0) {
    const removedIds = plan.removeMissingExternal.map((project) => project.id);
    await db
      .delete(dockerContainerFolderAssignments)
      .where(
        and(
          eq(dockerContainerFolderAssignments.nodeId, nodeId),
          eq(dockerContainerFolderAssignments.resourceType, 'compose'),
          inArray(dockerContainerFolderAssignments.resourceKey, removedIds)
        )
      );
    await db.delete(dockerComposeProjects).where(inArray(dockerComposeProjects.id, removedIds));
    for (const project of plan.removeMissingExternal) {
      onChange?.({ action: 'removed', projectId: project.id, projectName: project.name });
    }
  }

  if (observed.length > 0) {
    const projects = await db
      .select({ id: dockerComposeProjects.id, name: dockerComposeProjects.name })
      .from(dockerComposeProjects)
      .where(
        and(
          eq(dockerComposeProjects.nodeId, nodeId),
          inArray(
            dockerComposeProjects.name,
            observed.map((project) => project.name)
          )
        )
      );
    for (const project of projects) {
      await db
        .insert(dockerContainerFolderAssignments)
        .values({
          nodeId,
          resourceType: 'compose',
          resourceKey: project.id,
          containerName: null,
          folderId: null,
          sortOrder: 0,
        })
        .onConflictDoNothing();
      if (plan.create.some((created) => created.name === project.name)) {
        onChange?.({ action: 'discovered', projectId: project.id, projectName: project.name });
      }
    }
  }

  return observed;
}

/** Project statuses the container observation may move between; any other one belongs to an operation. */
const OBSERVED_RUN_STATUSES = ['running', 'degraded', 'stopped'] as const;

/**
 * N-25: a managed project that should run follows what its containers do. A service stopped outside Gateway left the
 * project "running" (and the status page operational) although the route answered 502. Projects with a Compose
 * operation in flight (it sets the status itself) and projects Availability runs (their copies move between nodes)
 * are left alone.
 */
async function reconcileManagedComposeRunStatus(
  db: DrizzleClient,
  nodeId: string,
  observed: Array<{ project: ComposeProjectObservation; existing?: ExistingComposeProject }>,
  containers: DockerResource[] | undefined,
  observedAt: Date,
  onChange?: (change: ComposeDiscoveryChange) => void
): Promise<void> {
  const states = observeComposeServiceStates(containers);
  const candidates = observed.flatMap(({ project, existing }) => {
    const state = states.get(project.name);
    if (!existing || !state || existing.managementState !== 'managed' || existing.desiredState !== 'running') return [];
    if (!(OBSERVED_RUN_STATUSES as readonly string[]).includes(existing.status ?? '')) return [];
    const next = observedComposeRunStatus(state);
    return next === existing.status ? [] : [{ existing, next }];
  });
  if (candidates.length === 0) return;
  const ids = candidates.map(({ existing }) => existing.id);
  const [operations, policies] = await Promise.all([
    db
      .select({ projectId: dockerComposeOperations.projectId })
      .from(dockerComposeOperations)
      .where(
        and(
          inArray(dockerComposeOperations.projectId, ids),
          inArray(dockerComposeOperations.status, ['pending', 'running', 'cancelling', 'reconciling'])
        )
      ),
    db
      .select({ projectId: dockerAvailabilityPolicies.composeProjectId })
      .from(dockerAvailabilityPolicies)
      .where(
        and(inArray(dockerAvailabilityPolicies.composeProjectId, ids), ne(dockerAvailabilityPolicies.mode, 'single'))
      ),
  ]);
  const skip = new Set([...operations, ...policies].map(({ projectId }) => projectId));
  for (const { existing, next } of candidates) {
    if (skip.has(existing.id)) continue;
    const [updated] = await db
      .update(dockerComposeProjects)
      .set({ status: next, updatedAt: observedAt })
      .where(
        and(
          eq(dockerComposeProjects.id, existing.id),
          eq(dockerComposeProjects.nodeId, nodeId),
          eq(dockerComposeProjects.desiredState, 'running'),
          inArray(dockerComposeProjects.status, [...OBSERVED_RUN_STATUSES])
        )
      )
      .returning({ id: dockerComposeProjects.id });
    if (updated) onChange?.({ action: 'observed', projectId: existing.id, projectName: existing.name });
  }
}
