import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { dockerComposeProjects, dockerComposeRevisions, dockerContainerFolderAssignments } from '@/db/schema/index.js';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_CONTAINER_NUMBER_LABEL = 'com.docker.compose.container-number';
const COMPOSE_VOLUME_LABEL = 'com.docker.compose.volume';
const COMPOSE_NETWORK_LABEL = 'com.docker.compose.network';
const COMPOSE_SIDECAR_LABEL = 'wiolett.gateway.compose.sidecar';

type DockerResource = Record<string, unknown>;
type ComposeResourceKind = 'container' | 'volume' | 'network';

export interface ComposeProjectObservation {
  name: string;
  observedFingerprint: string;
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
  const entries = new Map<string, string[]>();
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
      const projectEntries = entries.get(project) ?? [];
      projectEntries.push(identity);
      entries.set(project, projectEntries);
    }
  }

  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, values]) => ({
      name,
      observedFingerprint: createHash('sha256')
        .update([...new Set(values)].sort().join('\n'))
        .digest('hex'),
    }));
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
  const observed = observeComposeProjects(input);
  const existingRows = await db
    .select({
      id: dockerComposeProjects.id,
      name: dockerComposeProjects.name,
      managementState: dockerComposeProjects.managementState,
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
    observedFingerprint: project.observedFingerprint,
    status: project.status,
    availability: project.availability,
    preserveWhenMissing: project.hasRevisions || project.folderId !== null || (project.folderSortOrder ?? 0) !== 0,
  }));
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
