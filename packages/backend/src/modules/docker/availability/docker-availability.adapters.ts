import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { parseDocument, stringify } from 'yaml';
import type { DrizzleClient } from '@/db/client.js';
import {
  dockerAvailabilityOperations,
  dockerBuildArtifacts,
  dockerComposeProjects,
  dockerComposeRevisions,
  dockerDeploymentRoutes,
  dockerDeploymentSlots,
  dockerDeployments,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { ManagedDatabaseBindingService } from '@/modules/databases/managed-database-bindings.service.js';
import {
  addManagedDatabaseBindingToYaml,
  composeBindingSecretKey,
  removeComposePublishedPortsForAvailability,
  removeManagedDatabaseBindingFromYaml,
} from '@/modules/docker/compose/compose-managed-bindings.js';
import type { DockerManagementService } from '@/modules/docker/docker.service.js';
import type { DockerEnvironmentService } from '@/modules/docker/docker-environment.service.js';
import type { DockerSecretService } from '@/modules/docker/docker-secret.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { NodeRegistryService } from '@/services/node-registry.service.js';
import type {
  DockerAvailabilityAdapter,
  DockerAvailabilityAdapterContext,
  DockerAvailabilityAdapterPreflight,
  DockerAvailabilityCandidateNode,
  DockerAvailabilityPlacementResult,
  DockerAvailabilityResolvedResource,
  DockerAvailabilityResource,
} from './docker-availability.types.js';

type AvailabilityDaemonState = {
  policyId?: string;
  placementId?: string;
  resourceKind?: string;
  resourceId?: string;
  generation?: number | string;
  highestGeneration?: number | string;
  state?: string;
  runtimeIdentity?: Record<string, unknown>;
  operationId?: string;
  lastIdempotencyKey?: string;
};

const availabilitySpecFingerprintLabel = 'wiolett.gateway.availability.spec-fingerprint';
const availabilityGenerationLabel = 'wiolett.gateway.availability.generation';

export interface DockerAvailabilityDependencyProjector {
  preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight>;
  prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies>;
  activate?(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void>;
  deactivateUnavailable?(context: DockerAvailabilityAdapterContext): Promise<void>;
  deactivate?(context: DockerAvailabilityAdapterContext): Promise<void>;
  adopt?(context: DockerAvailabilityAdapterContext): Promise<void>;
  prepareFinalAdoption?(context: DockerAvailabilityAdapterContext): Promise<void>;
  finalizeAdoption?(context: DockerAvailabilityAdapterContext): Promise<void>;
  cleanup(context: DockerAvailabilityAdapterContext): Promise<void>;
}

export interface DockerAvailabilityPreparedDependencies {
  environment: Record<string, string>;
  networkNames: string[];
  extraHosts: Record<string, string>;
  composeYaml?: string;
  composeSecrets?: Record<string, string>;
}

const EMPTY_DEPENDENCIES: DockerAvailabilityPreparedDependencies = {
  environment: {},
  networkNames: [],
  extraHosts: {},
};

function isDigestPinnedImageReference(value: unknown): boolean {
  return /(?:^|@)sha256:[0-9a-f]{64}$/i.test(String(value ?? ''));
}

const NOOP_PROJECTOR: DockerAvailabilityDependencyProjector = {
  async preflight() {
    return { blockers: [], warnings: [] };
  },
  async prepare() {
    return EMPTY_DEPENDENCIES;
  },
  async cleanup() {},
};

export class CompositeDockerAvailabilityProjector implements DockerAvailabilityDependencyProjector {
  constructor(private readonly projectors: DockerAvailabilityDependencyProjector[]) {}

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ) {
    const results = await Promise.all(
      this.projectors.map((projector) => projector.preflight(resource, candidateNodes, scopes))
    );
    return {
      blockers: results.flatMap((result) => result.blockers),
      warnings: results.flatMap((result) => result.warnings),
    };
  }

  async prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies> {
    let merged = { ...EMPTY_DEPENDENCIES };
    for (const projector of this.projectors) {
      const next = await projector.prepare(context);
      merged = {
        environment: { ...merged.environment, ...next.environment },
        networkNames: [...new Set([...merged.networkNames, ...next.networkNames])],
        extraHosts: { ...merged.extraHosts, ...next.extraHosts },
        composeYaml: next.composeYaml ?? merged.composeYaml,
        composeSecrets: { ...(merged.composeSecrets ?? {}), ...(next.composeSecrets ?? {}) },
      };
    }
    return merged;
  }

  async activate(context: DockerAvailabilityAdapterContext, result: DockerAvailabilityPlacementResult): Promise<void> {
    for (const projector of this.projectors) await projector.activate?.(context, result);
  }

  async deactivate(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of [...this.projectors].reverse()) await projector.deactivate?.(context);
  }

  async deactivateUnavailable(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of [...this.projectors].reverse()) await projector.deactivateUnavailable?.(context);
  }

  async adopt(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of this.projectors) await projector.adopt?.(context);
  }

  async prepareFinalAdoption(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of this.projectors) await projector.prepareFinalAdoption?.(context);
  }

  async finalizeAdoption(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of this.projectors) await projector.finalizeAdoption?.(context);
  }

  async cleanup(context: DockerAvailabilityAdapterContext): Promise<void> {
    for (const projector of [...this.projectors].reverse()) await projector.cleanup(context);
  }
}

export class ManagedDatabaseAvailabilityProjector implements DockerAvailabilityDependencyProjector {
  constructor(
    private readonly bindings: ManagedDatabaseBindingService,
    private readonly nodeRegistry: NodeRegistryService
  ) {}

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight> {
    const blockers: DockerAvailabilityAdapterPreflight['blockers'] = [
      ...(await this.bindings.availabilityPreflight(resource, scopes)),
    ];
    for (const node of candidateNodes) {
      if (node.compatible && !this.nodeRegistry.hasCapability(node.id, 'managed_database_binding_listener_v1')) {
        blockers.push({
          code: 'AVAILABILITY_DATABASE_LINK_CAPABILITY_UNAVAILABLE',
          message: 'Docker node cannot project managed database Secure Links',
          nodeId: node.id,
        });
      }
    }
    return { blockers, warnings: [] };
  }

  async prepare(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPreparedDependencies> {
    const projections = await this.bindings.prepareAvailabilityPlacement(context);
    const environment: Record<string, string> = {};
    const extraHosts: Record<string, string> = {};
    const networkNames: string[] = [];
    let composeYaml = String(context.resource.portableSpec.yaml ?? '');
    const composeSecrets: Record<string, string> = {};
    for (const projection of projections) {
      Object.assign(environment, projection.environment);
      extraHosts[projection.connectorAlias] = projection.connectorAddress;
      networkNames.push(projection.networkName);
      if (context.resource.kind === 'compose' && projection.composeServiceName) {
        composeYaml = removeManagedDatabaseBindingFromYaml(composeYaml, projection.composeServiceName, {
          bindingId: projection.bindingId,
          networkName: projection.logicalNetworkName,
          hostAlias: projection.connectorAlias,
          hostAddress: projection.logicalConnectorAddress,
          environment: projection.environment,
        }).yaml;
        const patched = addManagedDatabaseBindingToYaml(composeYaml, projection.composeServiceName, {
          bindingId: projection.projectionId,
          networkName: projection.networkName,
          hostAlias: projection.connectorAlias,
          hostAddress: projection.connectorAddress,
          environment: projection.environment,
        });
        composeYaml = patched.yaml;
        for (const [name, value] of Object.entries(projection.environment)) {
          composeSecrets[composeBindingSecretKey(projection.projectionId, name)] = value;
        }
      }
    }
    return {
      environment,
      networkNames: [...new Set(networkNames)],
      extraHosts,
      ...(context.resource.kind === 'compose' ? { composeYaml, composeSecrets } : {}),
    };
  }

  async cleanup(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.bindings.cleanupAvailabilityPlacement(context.placementId);
  }

  async adopt(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.bindings.adoptAvailabilityPlacementAsSingle(context);
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function canonicalComposeSourceImage(
  images: Array<Record<string, unknown>>,
  ...candidates: Array<string | null | undefined>
): string | null {
  const targets = new Set(candidates.map((candidate) => String(candidate ?? '')).filter(Boolean));
  const image = images.find((row) => {
    const identities = [row.Id, row.ID, row.id, row.ImageID, row.imageId].map((value) => String(value ?? ''));
    const references = [
      ...(Array.isArray(row.RepoTags) ? row.RepoTags : []),
      ...(Array.isArray(row.repoTags) ? row.repoTags : []),
      ...(Array.isArray(row.RepoDigests) ? row.RepoDigests : []),
      ...(Array.isArray(row.repoDigests) ? row.repoDigests : []),
    ].map(String);
    return [...identities, ...references].some((value) => targets.has(value));
  });
  if (!image) return null;
  return (
    [...(Array.isArray(image.RepoTags) ? image.RepoTags : []), ...(Array.isArray(image.repoTags) ? image.repoTags : [])]
      .map(String)
      .find(
        (value) =>
          value !== '<none>:<none>' &&
          !/^127\.0\.0\.1:5443\//i.test(value) &&
          !/(^|\/)gateway\/availability\//i.test(value)
      ) ?? null
  );
}

export function rewriteComposeSourceImages(yaml: string, images: Record<string, string>): string {
  if (Object.keys(images).length === 0) return yaml;
  const document = parseDocument(yaml, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    customTags: [],
    logLevel: 'silent',
  });
  if (document.errors.length) {
    throw new AppError(
      409,
      'AVAILABILITY_COMPOSE_REWRITE_FAILED',
      'Compose image references cannot be rewritten safely'
    );
  }
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false }) as Record<string, any> | null;
  if (!value) return yaml;
  for (const [serviceName, image] of Object.entries(images)) {
    const service = value.services?.[serviceName] as Record<string, unknown> | undefined;
    if (service) service.image = image;
  }
  return stringify(value, { sortMapEntries: false });
}

export function composeSourceImages(yaml: string): Record<string, string> {
  const document = parseDocument(yaml, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    customTags: [],
    logLevel: 'silent',
  });
  if (document.errors.length) return {};
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false }) as Record<string, any> | null;
  if (!value) return {};
  return Object.fromEntries(
    Object.entries((value.services ?? {}) as Record<string, Record<string, unknown>>).flatMap(
      ([serviceName, service]) => {
        const image = String(service.image ?? '').trim();
        return image ? [[serviceName, image]] : [];
      }
    )
  );
}

function internalName(kind: string, context: DockerAvailabilityAdapterContext): string {
  return `gwav-${kind}-${context.policyId.slice(0, 8)}-${context.placementId.slice(0, 8)}`;
}

function placementContainerRuntimeName(context: DockerAvailabilityAdapterContext): string {
  return context.nodeId === context.resource.currentNodeId
    ? context.resource.displayName
    : internalName('container', context);
}

function sanitizedLabels(labels: unknown): Record<string, string> {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels as Record<string, unknown>)
      .filter(
        ([key, value]) =>
          typeof value === 'string' &&
          !key.startsWith('wiolett.gateway.availability.') &&
          !/(secret|token|password|credential|authorization)/i.test(key)
      )
      .map(([key, value]) => [key, String(value)])
  );
}

export function availabilityPlacementOwner(inspect: Record<string, any>): {
  policyId: string;
  placementId: string;
} {
  const labels = availabilityInspectLabels(inspect);
  return {
    policyId: String(labels['wiolett.gateway.availability.policy'] ?? ''),
    placementId: String(labels['wiolett.gateway.availability.placement'] ?? ''),
  };
}

export function availabilityPlacementGeneration(inspect: Record<string, any>): number | null {
  const value = Number(availabilityInspectLabels(inspect)[availabilityGenerationLabel]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function isReplaceableStalePlacementContainer(
  inspect: Record<string, any>,
  context: Pick<DockerAvailabilityAdapterContext, 'policyId' | 'placementId' | 'generation'>
): boolean {
  const owner = availabilityPlacementOwner(inspect);
  const generation = availabilityPlacementGeneration(inspect);
  return (
    owner.policyId === context.policyId &&
    owner.placementId === context.placementId &&
    generation !== null &&
    generation <= context.generation
  );
}

export function availabilityContainerRuntimeSpec(spec: Record<string, any>): Record<string, any> {
  const { sourceImageReference: _sourceImageReference, ...runtimeSpec } = spec;
  return runtimeSpec;
}

export function availabilityPlacementSpecFingerprint(inspect: Record<string, any>): string {
  return String(availabilityInspectLabels(inspect)[availabilitySpecFingerprintLabel] ?? '');
}

function availabilityInspectLabels(inspect: Record<string, any>): Record<string, unknown> {
  const labelCandidates = [
    inspect.Config?.Labels,
    inspect.Config?.labels,
    inspect.config?.Labels,
    inspect.config?.labels,
    inspect.Labels,
    inspect.labels,
  ];
  for (const candidate of labelCandidates) {
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

export function placementContainerHasFailedRuntime(inspect: Record<string, any>): boolean {
  const state = (inspect.State ?? inspect.state ?? {}) as Record<string, unknown>;
  const running = state.Running === true || String(state.Status ?? state.status ?? '').toLowerCase() === 'running';
  return !running && String(state.Error ?? state.error ?? '').trim().length > 0;
}

function deploymentContainerIsRunning(container: Record<string, any>): boolean {
  if (container.running === true || container.Running === true) return true;
  return (
    String(container.state ?? container.State ?? container.status ?? container.Status ?? '').toLowerCase() === 'running'
  );
}

export function availabilityPlacementLabels(
  context: Pick<DockerAvailabilityAdapterContext, 'policyId' | 'placementId' | 'generation' | 'nodeId' | 'resource'>,
  labels: unknown
): Record<string, string> {
  const result: Record<string, string> = {
    ...sanitizedLabels(labels),
    ...(context.nodeId === context.resource.currentNodeId ? {} : { 'wiolett.gateway.availability.managed': 'true' }),
    'wiolett.gateway.availability.policy': context.policyId,
    'wiolett.gateway.availability.placement': context.placementId,
    [availabilityGenerationLabel]: String(context.generation),
  };
  if (context.resource.specFingerprint) result[availabilitySpecFingerprintLabel] = context.resource.specFingerprint;
  return result;
}

function parseDetail(detail: string | undefined): Record<string, any> {
  if (!detail) return {};
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseStrictDetail(detail: string | undefined, code: string, message: string): Record<string, any> {
  if (!detail) throw new AppError(502, code, message);
  try {
    const parsed = JSON.parse(detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
    return parsed as Record<string, any>;
  } catch {
    throw new AppError(502, code, message);
  }
}

function parseStrictListDetail(detail: string | undefined, code: string, message: string): Array<Record<string, any>> {
  if (!detail) throw new AppError(502, code, message);
  try {
    const parsed = JSON.parse(detail);
    if (!Array.isArray(parsed)) throw new Error('array expected');
    return parsed as Array<Record<string, any>>;
  } catch {
    throw new AppError(502, code, message);
  }
}

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /not found|no such/i.test(message);
}

function immutableImageIdentityMatches(inspect: Record<string, any>, expected: unknown): boolean {
  const expectedReference = String(expected ?? '');
  if (!isDigestPinnedImageReference(expectedReference)) return false;
  const config = (inspect.Config ?? inspect.config ?? {}) as Record<string, any>;
  const configuredReference = String(config.Image ?? config.image ?? '');
  const imageId = String(inspect.Image ?? inspect.image ?? inspect.imageId ?? inspect.ImageID ?? '');
  if (configuredReference !== expectedReference || !/^sha256:[0-9a-f]{64}$/i.test(imageId)) return false;
  const repoDigests = [
    ...(Array.isArray(inspect.RepoDigests) ? inspect.RepoDigests : []),
    ...(Array.isArray(inspect.repoDigests) ? inspect.repoDigests : []),
    ...(Array.isArray(config.RepoDigests) ? config.RepoDigests : []),
    ...(Array.isArray(config.repoDigests) ? config.repoDigests : []),
  ].map(String);
  return repoDigests.length === 0 || repoDigests.includes(expectedReference);
}

function arrayEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(Array.isArray(right) ? right : []);
}

function stringMapContains(actual: unknown, expected: unknown): boolean {
  const actualLabels = sanitizedLabels(actual);
  const expectedLabels = sanitizedLabels(expected);
  return Object.entries(expectedLabels).every(([key, value]) => actualLabels[key] === value);
}

function containerCanonicalSpecMatches(
  inspect: Record<string, any>,
  context: DockerAvailabilityAdapterContext,
  expectedName: string,
  requireAvailabilityIdentity: boolean,
  allowStaleGeneration = false
): boolean {
  const config = (inspect.Config ?? inspect.config ?? {}) as Record<string, any>;
  const host = (inspect.HostConfig ?? inspect.hostConfig ?? {}) as Record<string, any>;
  const spec = context.resource.portableSpec as Record<string, any>;
  const actualName = String(inspect.Name ?? inspect.name ?? '').replace(/^\/+/, '');
  if (actualName && actualName !== expectedName) return false;
  const unmanagedOrigin = !requireAvailabilityIdentity && availabilityPlacementGeneration(inspect) === null;
  if (!unmanagedOrigin && !immutableImageIdentityMatches(inspect, context.resource.imageReference ?? spec.image)) {
    return false;
  }
  if (!arrayEquals(config.Cmd ?? config.cmd, spec.cmd)) return false;
  if (!arrayEquals(config.Entrypoint ?? config.entrypoint, spec.entrypoint)) return false;
  if (String(config.WorkingDir ?? config.working_dir ?? '') !== String(spec.working_dir ?? '')) return false;
  if (String(config.User ?? config.user ?? '') !== String(spec.user ?? '')) return false;
  if (String(config.Hostname ?? config.hostname ?? '') !== String(spec.hostname ?? '')) return false;
  if ((config.Tty === true) !== (spec.tty === true)) return false;
  if ((config.OpenStdin === true) !== (spec.open_stdin === true)) return false;
  if (spec.stopTimeout !== undefined && Number(config.StopTimeout ?? config.stopTimeout) !== Number(spec.stopTimeout)) {
    return false;
  }
  if (
    String(host.RestartPolicy?.Name ?? host.restartPolicy?.name ?? 'unless-stopped') !==
    String(spec.restartPolicy ?? 'unless-stopped')
  ) {
    return false;
  }
  if (spec.runtimeProfile !== undefined) {
    const actualProfile = host.Runtime === 'runsc' || host.runtime === 'runsc' ? 'secure' : 'default';
    if (actualProfile !== String(spec.runtimeProfile)) return false;
  }
  if (!stringMapContains(config.Labels ?? config.labels, spec.labels)) return false;
  if (requireAvailabilityIdentity) {
    const owner = availabilityPlacementOwner(inspect);
    return (
      owner.policyId === context.policyId &&
      owner.placementId === context.placementId &&
      availabilityPlacementGeneration(inspect) !== null &&
      (availabilityPlacementGeneration(inspect) === context.generation ||
        (allowStaleGeneration && availabilityPlacementGeneration(inspect)! < context.generation)) &&
      availabilityPlacementSpecFingerprint(inspect) === context.resource.specFingerprint
    );
  }
  return true;
}

function deploymentRowLabels(row: Record<string, any>): Record<string, unknown> {
  const labels = row.labels ?? row.Labels ?? {};
  return labels && typeof labels === 'object' && !Array.isArray(labels) ? (labels as Record<string, unknown>) : {};
}

function deploymentRowName(row: Record<string, any>): string {
  return String(row.name ?? row.Name ?? '');
}

function observedDeploymentActiveSlot(
  containers: unknown,
  runtime: { slots: { blue: string; green: string } },
  fallback: string
): 'blue' | 'green' {
  const rows = Array.isArray(containers) ? (containers as Array<Record<string, any>>) : [];
  const preferred = fallback === 'green' ? 'green' : 'blue';
  for (const slot of [preferred, preferred === 'blue' ? 'green' : 'blue'] as const) {
    const running = rows.some((row) => {
      const labels = deploymentRowLabels(row);
      return (
        deploymentRowName(row) === runtime.slots[slot] &&
        labels['wiolett.gateway.deployment.role'] === 'app' &&
        labels['wiolett.gateway.deployment.slot'] === slot &&
        deploymentContainerIsRunning(row)
      );
    });
    if (running) return slot;
  }
  return fallback === 'green' ? 'green' : 'blue';
}

function immutableRuntimeRowImageMatches(row: Record<string, any>, expected: unknown): boolean {
  const expectedReference = String(expected ?? '');
  if (!isDigestPinnedImageReference(expectedReference)) return false;
  const imageId = String(row.imageId ?? row.ImageID ?? '');
  const imageReference = String(row.image ?? row.Image ?? '');
  if (!/^sha256:[0-9a-f]{64}$/i.test(imageId)) return false;
  if (/^sha256:[0-9a-f]{64}$/i.test(expectedReference)) {
    return imageId.toLowerCase() === expectedReference.toLowerCase() || imageReference === expectedReference;
  }
  const repoDigests = [
    ...(Array.isArray(row.repoDigests) ? row.repoDigests : []),
    ...(Array.isArray(row.RepoDigests) ? row.RepoDigests : []),
  ].map(String);
  return imageReference === expectedReference || repoDigests.includes(expectedReference);
}

function immutableRuntimeRowHasImageId(row: Record<string, any>): boolean {
  return /^sha256:[0-9a-f]{64}$/i.test(String(row.imageId ?? row.ImageID ?? ''));
}

function availabilityComposeOperationId(context: DockerAvailabilityAdapterContext, suffix: string): string {
  const digest = fingerprint({
    policyId: context.policyId,
    placementId: context.placementId,
    generation: context.generation,
    operationId: context.operationId,
    idempotencyKey: context.idempotencyKey,
    suffix,
  }).slice(0, 32);
  return `${context.operationId}:${digest}`;
}

function composeRuntimeProjectName(context: DockerAvailabilityAdapterContext): string {
  return context.nodeId === context.resource.currentNodeId
    ? context.resource.displayName
    : internalName('compose', context);
}

function composeOwnedNetworkNames(projectName: string, spec: Record<string, any>): string[] {
  const networks = (spec.normalizedModel?.networks ?? {}) as Record<string, Record<string, unknown> | null>;
  const names = Object.entries(networks)
    .filter(([, config]) => config?.external !== true && !String(config?.name ?? '').trim())
    .map(([name]) => `${projectName}_${name}`);
  return [...new Set(names.length > 0 ? names : [`${projectName}_default`])];
}

export function deploymentPlacementSnapshot(
  spec: Record<string, any>,
  runtime: { deploymentId: string; routerName: string; networkName: string; slots: { blue: string; green: string } },
  desiredConfig: Record<string, any>,
  observed: Record<string, any>,
  priorRuntimeIdentity?: Record<string, unknown>
) {
  return {
    ...observed,
    id: runtime.deploymentId,
    routerName: runtime.routerName,
    routerImage: String(spec.routerImage ?? ''),
    networkName: runtime.networkName,
    activeSlot: observedDeploymentActiveSlot(
      observed.containers,
      runtime,
      String(priorRuntimeIdentity?.activeSlot ?? observed.activeSlot ?? spec.activeSlot ?? 'blue')
    ),
    routes: spec.routes ?? [],
    healthConfig: spec.health ?? {},
    desiredConfig,
    slots: (['blue', 'green'] as const).map((slot) => ({
      slot,
      containerName: runtime.slots[slot],
    })),
  };
}

function deploymentAvailabilitySnapshot(
  context: DockerAvailabilityAdapterContext,
  runtime: { deploymentId: string; routerName: string; networkName: string; slots: { blue: string; green: string } },
  observed: Record<string, any> = {},
  priorRuntimeIdentity?: Record<string, unknown>
) {
  const spec = context.resource.portableSpec as Record<string, any>;
  const desiredConfig = {
    ...(spec.desiredConfig ?? {}),
    image: context.resource.imageReference ?? spec.desiredConfig?.image,
    labels:
      context.nodeId === context.resource.currentNodeId
        ? sanitizedLabels(spec.desiredConfig?.labels)
        : availabilityPlacementLabels(context, spec.desiredConfig?.labels),
  };
  return deploymentPlacementSnapshot(spec, runtime, desiredConfig, observed, priorRuntimeIdentity);
}

abstract class BaseAvailabilityAdapter {
  constructor(
    protected readonly db: DrizzleClient,
    protected readonly dispatch: NodeDispatchService,
    protected readonly projector: DockerAvailabilityDependencyProjector = NOOP_PROJECTOR
  ) {}

  async refreshPlacementDependencies(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult
  ): Promise<void> {
    await this.projector.activate?.(context, result);
  }

  protected async daemon(
    context: DockerAvailabilityAdapterContext,
    action: 'prepare' | 'activate' | 'inspect' | 'stop' | 'drain' | 'remove' | 'adopt_single',
    config: Record<string, unknown> = {}
  ): Promise<AvailabilityDaemonState> {
    this.assertAvailabilityMutationContext(context);
    const result = await this.dispatch.sendDockerAvailabilityCommand(context.nodeId, {
      action,
      policyId: context.policyId,
      placementId: context.placementId,
      generation: context.generation,
      operationId: context.operationId,
      idempotencyKey: `${context.idempotencyKey}:${action}`,
      resourceKind: context.resource.kind,
      resourceId: context.resource.resourceId,
      configJson: JSON.stringify(config),
    });
    if (!result.success) {
      if (/stale availability generation|below persisted highest generation/i.test(result.error ?? '')) {
        throw new AppError(
          409,
          'AVAILABILITY_STALE_GENERATION',
          result.error || `Docker ${action} rejected a stale Availability generation`
        );
      }
      if (/invalid availability lifecycle transition:/i.test(result.error ?? '')) {
        throw new AppError(409, 'AVAILABILITY_LIFECYCLE_TRANSITION_INVALID', result.error!, {
          retryable: false,
        });
      }
      if (/availability placement .* resource identity conflicts with persisted state/i.test(result.error ?? '')) {
        throw new AppError(409, 'AVAILABILITY_DAEMON_IDENTITY_MISMATCH', result.error!, {
          retryable: false,
        });
      }
      throw new AppError(502, 'AVAILABILITY_DAEMON_COMMAND_FAILED', result.error || `Docker ${action} failed`, {
        retryable: true,
      });
    }
    const state = parseStrictDetail(
      result.detail,
      'AVAILABILITY_DAEMON_RESPONSE_INVALID',
      `Docker availability ${action} returned an invalid state response`
    ) as AvailabilityDaemonState;
    const acknowledgedGeneration = Number(state.generation ?? state.highestGeneration);
    if (
      state.policyId !== context.policyId ||
      state.placementId !== context.placementId ||
      state.resourceKind !== context.resource.kind ||
      state.resourceId !== context.resource.resourceId
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_DAEMON_IDENTITY_MISMATCH',
        `Docker availability ${action} returned a different workload identity`
      );
    }
    if (
      action !== 'inspect' &&
      (!Number.isInteger(acknowledgedGeneration) || acknowledgedGeneration !== context.generation)
    ) {
      throw new AppError(
        409,
        acknowledgedGeneration < context.generation
          ? 'AVAILABILITY_STALE_GENERATION'
          : 'AVAILABILITY_GENERATION_MISMATCH',
        `Docker availability ${action} acknowledged generation ${String(
          state.generation ?? state.highestGeneration ?? 'unknown'
        )}, expected ${context.generation}`
      );
    }
    return state;
  }

  protected async inspectOptional(context: DockerAvailabilityAdapterContext): Promise<AvailabilityDaemonState> {
    try {
      return await this.daemon(context, 'inspect');
    } catch (error) {
      if (error instanceof AppError && /availability placement [^\n]+ is not persisted$/i.test(error.message))
        return {};
      throw error;
    }
  }

  protected async claimGeneration(context: DockerAvailabilityAdapterContext): Promise<void> {
    this.assertAvailabilityMutationContext(context);
    await this.assertOperationLease(context);
    const current = await this.inspectOptional(context);
    const generation = Number(current.generation ?? current.highestGeneration ?? 0);
    if (generation > context.generation) {
      throw new AppError(409, 'AVAILABILITY_STALE_GENERATION', 'A newer Availability generation owns this placement');
    }
    if (generation === context.generation) {
      if (current.state === 'removed') {
        throw new AppError(
          409,
          'AVAILABILITY_PLACEMENT_RETIRED',
          'The previous placement identity is retired and must be replaced'
        );
      }
      return;
    }
    await this.daemon(context, 'prepare', {
      phase: 'claimed',
      ...(current.runtimeIdentity ? { runtimeIdentity: current.runtimeIdentity } : {}),
    });
  }

  protected async fence(context: DockerAvailabilityAdapterContext): Promise<void> {
    this.assertAvailabilityMutationContext(context);
    await this.assertOperationLease(context);
    const current = await this.daemon(context, 'inspect');
    const generation = Number(current.generation ?? current.highestGeneration);
    if (!Number.isInteger(generation) || generation !== context.generation) {
      throw new AppError(
        409,
        generation < context.generation ? 'AVAILABILITY_STALE_GENERATION' : 'AVAILABILITY_GENERATION_MISMATCH',
        `Docker availability fencing observed generation ${String(
          current.generation ?? current.highestGeneration ?? 'unknown'
        )}, expected ${context.generation}`
      );
    }
  }

  protected async claimAndFence(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.claimGeneration(context);
    await this.fence(context);
  }

  private assertAvailabilityMutationContext(context: DockerAvailabilityAdapterContext): void {
    const missing = [
      ['policyId', context?.policyId],
      ['placementId', context?.placementId],
      ['operationId', context?.operationId],
      ['idempotencyKey', context?.idempotencyKey],
      ['nodeId', context?.nodeId],
      ['resource.kind', context?.resource?.kind],
      ['resource.resourceId', context?.resource?.resourceId],
      ['resource.specFingerprint', context?.resource?.specFingerprint],
    ].filter(([, value]) => typeof value !== 'string' || value.trim() === '');
    if (missing.length > 0 || !Number.isInteger(context?.generation) || context.generation <= 0) {
      const fields = missing.map(([field]) => field);
      if (!Number.isInteger(context?.generation) || context.generation <= 0) fields.push('generation');
      throw new AppError(
        409,
        'AVAILABILITY_MUTATION_GUARD_INVALID',
        `Availability mutation guard is incomplete: ${fields.join(', ')}`
      );
    }
  }

  private async assertOperationLease(context: DockerAvailabilityAdapterContext): Promise<void> {
    if (!context.leaseOwner) return;
    const [lease] = await this.db
      .update(dockerAvailabilityOperations)
      .set({
        leaseHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 20 * 60_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dockerAvailabilityOperations.id, context.operationId),
          eq(dockerAvailabilityOperations.leaseOwner, context.leaseOwner),
          eq(dockerAvailabilityOperations.status, 'running')
        )
      )
      .returning({ id: dockerAvailabilityOperations.id });
    if (!lease) {
      throw new AppError(
        409,
        'AVAILABILITY_OPERATION_LEASE_LOST',
        'Availability operation no longer owns the workload mutation lease'
      );
    }
  }

  protected result(
    context: DockerAvailabilityAdapterContext,
    daemon: AvailabilityDaemonState,
    runtimeIdentity: Record<string, unknown>,
    imageReference?: string,
    composeRevisionId?: string
  ): DockerAvailabilityPlacementResult {
    return {
      acknowledgedGeneration: Number(daemon.generation ?? context.generation),
      actualState: 'serving',
      serving: true,
      dependencyState: 'ready',
      applicationHealth: 'healthy',
      runtimeIdentity,
      imageReference,
      composeRevisionId,
    };
  }

  protected stoppedResult(
    context: DockerAvailabilityAdapterContext,
    daemon: AvailabilityDaemonState,
    runtimeIdentity: Record<string, unknown>,
    imageReference?: string,
    composeRevisionId?: string
  ): DockerAvailabilityPlacementResult {
    return {
      acknowledgedGeneration: Number(daemon.generation ?? context.generation),
      actualState: 'stopped',
      serving: false,
      dependencyState: 'ready',
      applicationHealth: 'unknown',
      runtimeIdentity,
      imageReference,
      composeRevisionId,
    };
  }

  protected async activateResult(
    context: DockerAvailabilityAdapterContext,
    result: DockerAvailabilityPlacementResult
  ): Promise<DockerAvailabilityPlacementResult> {
    await context.reportProgress?.('activating_routes', 'Activating Secure Links and publishing healthy routes');
    await this.fence(context);
    await this.projector.activate?.(context, result);
    return result;
  }

  async deactivatePlacement(context: DockerAvailabilityAdapterContext): Promise<void> {
    await this.claimAndFence(context);
    await this.projector.deactivate?.(context);
  }

  async deactivatePlacementDependencies(context: DockerAvailabilityAdapterContext): Promise<void> {
    this.assertAvailabilityMutationContext(context);
    await this.projector.deactivateUnavailable?.(context);
  }

  async finalizePlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void> {
    this.assertAvailabilityMutationContext(context);
    await this.projector.finalizeAdoption?.(context);
  }

  protected async combinedPreflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    blockers: DockerAvailabilityAdapterPreflight['blockers'],
    scopes: string[]
  ): Promise<DockerAvailabilityAdapterPreflight> {
    const dependencies = await this.projector.preflight(resource, candidateNodes, scopes);
    return { blockers: [...blockers, ...dependencies.blockers], warnings: dependencies.warnings };
  }

  async inspectPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult | null> {
    const state = await this.daemon(context, 'inspect');
    if (!state.generation || state.state === 'removed') return null;
    const serving = state.state === 'active' || state.state === 'single';
    return {
      acknowledgedGeneration: Number(state.generation),
      actualState: serving ? 'serving' : state.state === 'draining' ? 'ready' : 'stopped',
      serving,
      dependencyState: 'ready',
      applicationHealth: serving ? 'healthy' : 'unknown',
      runtimeIdentity: state.runtimeIdentity ?? {},
    };
  }
}

export class DockerContainerAvailabilityAdapter extends BaseAvailabilityAdapter implements DockerAvailabilityAdapter {
  readonly kind = 'container' as const;

  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    private readonly docker: DockerManagementService,
    private readonly environment: DockerEnvironmentService,
    private readonly secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  ) {
    super(db, dispatch, projector);
  }

  async resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource> {
    if (resource.type !== 'container')
      throw new AppError(400, 'AVAILABILITY_RESOURCE_KIND_MISMATCH', 'Container expected');
    const inspect = await this.docker.inspectUserContainer(resource.nodeId, resource.containerName);
    const name = String(inspect?.Name ?? inspect?.name ?? resource.containerName).replace(/^\/+/, '');
    const host = (inspect?.HostConfig ?? {}) as Record<string, any>;
    const config = (inspect?.Config ?? {}) as Record<string, any>;
    const runtimeImage = String(inspect?.Image ?? inspect?.image ?? '');
    const portableSpec = {
      name,
      image: String(config.Image ?? ''),
      cmd: Array.isArray(config.Cmd) ? config.Cmd : [],
      entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint : [],
      labels: sanitizedLabels(config.Labels),
      working_dir: String(config.WorkingDir ?? ''),
      user: String(config.User ?? ''),
      hostname: String(config.Hostname ?? ''),
      stopTimeout: typeof config.StopTimeout === 'number' ? config.StopTimeout : undefined,
      tty: config.Tty === true,
      open_stdin: config.OpenStdin === true,
      restartPolicy: String(host.RestartPolicy?.Name ?? 'unless-stopped'),
      runtimeProfile: host.Runtime === 'runsc' ? 'secure' : 'default',
    };
    const imageReference = portableSpec.image.trim() || runtimeImage;
    portableSpec.image = imageReference;
    return {
      kind: 'container',
      reference: resource,
      resourceId: String(inspect?.scopeResourceId ?? name),
      displayName: name,
      currentNodeId: resource.nodeId,
      viewScope: 'docker:containers:view',
      manageScope: 'docker:containers:manage',
      specFingerprint: fingerprint(portableSpec),
      portableSpec,
      imageReference,
      sourceImageReference: imageReference,
      running: inspect?.State?.Running === true || String(inspect?.State?.Status ?? '').toLowerCase() === 'running',
    };
  }

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ) {
    const inspect = resource.authoritativeSnapshot
      ? null
      : await this.docker.inspectUserContainer(resource.currentNodeId, resource.displayName);
    const host = (inspect?.HostConfig ?? {}) as Record<string, any>;
    const blockers = [] as DockerAvailabilityAdapterPreflight['blockers'];
    if (!resource.authoritativeSnapshot && ((inspect?.Mounts?.length ?? 0) > 0 || (host.Binds?.length ?? 0) > 0)) {
      blockers.push({
        code: 'AVAILABILITY_MOUNTS_UNSUPPORTED',
        message: 'Containers with any mount cannot use Availability',
      });
    }
    return this.combinedPreflight(resource, candidateNodes, blockers, scopes);
  }

  async ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    const priorGeneration = Number(prior.generation ?? 0);
    await this.claimAndFence(context);
    await context.reportProgress?.('preparing_dependencies', 'Preparing database links and networks');
    const dependencies = await this.projector.prepare(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const placementContainerName = placementContainerRuntimeName(context);
    // An origin adopted without recreation has no HA labels. Only the exact
    // immutable Docker ID previously acknowledged by this placement is owned;
    // its name alone must never authorize replacement.
    const isRecordedOrigin = (inspect: Record<string, any>): boolean => {
      const recordedId = String(prior.runtimeIdentity?.containerId ?? '');
      const owner = availabilityPlacementOwner(inspect);
      return (
        context.nodeId === context.resource.currentNodeId &&
        priorGeneration > 0 &&
        prior.state !== 'single' &&
        /^[a-f0-9]{64}$/.test(recordedId) &&
        String(inspect.Id ?? inspect.id ?? '') === recordedId &&
        String(inspect.Name ?? inspect.name ?? '').replace(/^\/+/, '') === placementContainerName &&
        !owner.policyId &&
        !owner.placementId &&
        availabilityPlacementGeneration(inspect) === null &&
        !availabilityPlacementSpecFingerprint(inspect)
      );
    };
    if (priorGeneration > 0 && priorGeneration < context.generation && prior.state !== 'single') {
      await this.fence(context);
      await this.projector.deactivate?.(context);
      const staleContainerId = String(prior.runtimeIdentity?.containerId ?? placementContainerName);
      let staleInspect: Record<string, any> | null = null;
      try {
        staleInspect = await this.inspectPlacementContainer(context.nodeId, staleContainerId);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (staleInspect) {
        if (!isReplaceableStalePlacementContainer(staleInspect, context) && !isRecordedOrigin(staleInspect)) {
          throw new AppError(
            409,
            'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
            'The stale placement container does not match the claimed Availability identity'
          );
        }
        await this.fence(context);
        const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
          containerId: String(staleInspect.Id ?? staleInspect.id ?? staleContainerId),
          force: true,
        });
        if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
          throw new AppError(
            502,
            'AVAILABILITY_CONTAINER_ROLLOUT_REMOVE_FAILED',
            removed.error || 'Container rollout cleanup failed'
          );
        }
      }
    }
    const createPlacementContainer = async (): Promise<Record<string, any>> => {
      await context.reportProgress?.('starting', 'Creating replacement container');
      const [env, secrets] = await Promise.all([
        this.environment.getDecryptedMap(context.resource.currentNodeId, context.resource.displayName),
        this.secrets.getDecryptedMap(context.resource.currentNodeId, context.resource.displayName),
      ]);
      const runtimeSpec = availabilityContainerRuntimeSpec(spec);
      await this.fence(context);
      const create = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'create', {
        configJson: JSON.stringify({
          ...runtimeSpec,
          name: placementContainerName,
          env: Object.entries({ ...env, ...secrets, ...dependencies.environment }).map(
            ([key, value]) => `${key}=${value}`
          ),
          network_mode: dependencies.networkNames[0],
          extra_hosts: Object.entries(dependencies.extraHosts).map(([host, address]) => `${host}:${address}`),
          labels: availabilityPlacementLabels(context, runtimeSpec.labels),
        }),
      });
      if (!create.success) {
        throw new AppError(502, 'AVAILABILITY_CONTAINER_CREATE_FAILED', create.error || 'Container creation failed');
      }
      const created = parseDetail(create.detail);
      return this.inspectPlacementContainer(context.nodeId, String(created.Id ?? created.id ?? placementContainerName));
    };
    let inspect: Record<string, any>;
    try {
      inspect = await this.inspectPlacementContainer(context.nodeId, placementContainerName);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      inspect = await createPlacementContainer();
    }
    const inspectedOwner = availabilityPlacementOwner(inspect);
    const inspectedGeneration = availabilityPlacementGeneration(inspect);
    const ownedByPlacement =
      inspectedOwner.policyId === context.policyId &&
      inspectedOwner.placementId === context.placementId &&
      inspectedGeneration !== null &&
      inspectedGeneration <= context.generation;
    if (
      (ownedByPlacement || isRecordedOrigin(inspect)) &&
      (!containerCanonicalSpecMatches(
        inspect,
        context,
        placementContainerName,
        context.nodeId !== context.resource.currentNodeId
      ) ||
        (isRecordedOrigin(inspect) &&
          String(inspect.Config?.Image ?? inspect.config?.image ?? '') !==
            String(context.resource.imageReference ?? spec.image)))
    ) {
      const staleContainerId = String(inspect.Id ?? inspect.id ?? placementContainerName);
      await this.fence(context);
      const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
        containerId: staleContainerId,
        force: true,
      });
      if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
        throw new AppError(
          502,
          'AVAILABILITY_CONTAINER_ROLLOUT_REMOVE_FAILED',
          removed.error || 'Container rollout cleanup failed'
        );
      }
      inspect = await createPlacementContainer();
    }
    if (context.nodeId !== context.resource.currentNodeId) {
      const owner = availabilityPlacementOwner(inspect);
      if (owner.policyId !== context.policyId || owner.placementId !== context.placementId) {
        throw new AppError(
          409,
          'AVAILABILITY_CONTAINER_NAME_CONFLICT',
          'The deterministic placement container name is already in use'
        );
      }
      if (!containerCanonicalSpecMatches(inspect, context, placementContainerName, true)) {
        throw new AppError(
          409,
          'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
          'The existing placement container does not match the claimed canonical spec or immutable image'
        );
      }
      if (placementContainerHasFailedRuntime(inspect)) {
        const failedContainerId = String(inspect.Id ?? inspect.id ?? placementContainerName);
        await this.fence(context);
        const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
          containerId: failedContainerId,
          force: true,
        });
        if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
          throw new AppError(
            502,
            'AVAILABILITY_CONTAINER_RECOVERY_REMOVE_FAILED',
            removed.error || 'Failed placement container cleanup failed'
          );
        }
        inspect = await createPlacementContainer();
        if (!containerCanonicalSpecMatches(inspect, context, placementContainerName, true)) {
          throw new AppError(
            502,
            'AVAILABILITY_CONTAINER_IDENTITY_UNVERIFIED',
            'The recreated placement container could not be verified against the claimed canonical spec'
          );
        }
      }
    } else if (!containerCanonicalSpecMatches(inspect, context, placementContainerName, false)) {
      throw new AppError(
        409,
        'AVAILABILITY_CONTAINER_ORIGIN_IDENTITY_UNVERIFIED',
        'The origin container does not match the canonical spec or immutable image'
      );
    }
    if (context.nodeId !== context.resource.currentNodeId && !availabilityPlacementSpecFingerprint(inspect)) {
      throw new AppError(
        409,
        'AVAILABILITY_CONTAINER_IDENTITY_UNVERIFIED',
        'The placement container is missing its canonical Availability spec fingerprint'
      );
    }
    if (
      context.nodeId !== context.resource.currentNodeId &&
      availabilityPlacementGeneration(inspect) !== context.generation
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_STALE_GENERATION',
        'The placement container belongs to a different Availability generation'
      );
    }
    const containerId = String(inspect.Id ?? inspect.id ?? placementContainerName);
    for (const networkName of dependencies.networkNames.slice(1)) {
      await this.fence(context);
      const connected = await this.dispatch.sendDockerNetworkCommand(context.nodeId, 'connect', {
        networkId: networkName,
        containerId,
      });
      if (!connected.success && !/already|exists/i.test(connected.error ?? '')) {
        throw new AppError(
          502,
          'AVAILABILITY_DATABASE_NETWORK_CONNECT_FAILED',
          connected.error || 'Network connect failed'
        );
      }
    }
    await this.fence(context);
    const started = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'start', { containerId });
    if (!started.success)
      throw new AppError(502, 'AVAILABILITY_CONTAINER_START_FAILED', started.error || 'Container start failed');
    await context.reportProgress?.('checking_health', 'Waiting for health checks or 10 seconds of stable runtime');
    await this.waitUntilReady(context.nodeId, containerId);
    await this.fence(context);
    const active = await this.daemon(context, 'activate', {
      runtimeIdentity: { containerId, containerName: placementContainerName },
    });
    return this.activateResult(
      context,
      this.result(
        context,
        active,
        { containerId, containerName: placementContainerName },
        context.resource.imageReference
      )
    );
  }

  private async waitUntilReady(nodeId: string, containerId: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    let lastState = 'starting';
    let stableSince = 0;
    let stableRestartCount = -1;
    while (Date.now() < deadline) {
      const inspect = await this.inspectPlacementContainer(nodeId, containerId);
      const state = (inspect?.State ?? {}) as Record<string, any>;
      lastState = String(state.Health?.Status ?? state.Status ?? 'unknown');
      if (state.Running === true && state.Health?.Status === 'healthy') return;
      if (state.Running === true && !state.Health?.Status && state.Restarting !== true) {
        const restartCount = Number(inspect?.RestartCount ?? 0);
        if (stableSince === 0 || restartCount !== stableRestartCount) {
          stableSince = Date.now();
          stableRestartCount = restartCount;
        } else if (Date.now() - stableSince >= 10_000) {
          return;
        }
      } else {
        stableSince = 0;
        stableRestartCount = -1;
      }
      if (state.Health?.Status === 'unhealthy' || state.Running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AppError(409, 'AVAILABILITY_CONTAINER_UNHEALTHY', `Container did not become ready (${lastState})`, {
      retryable: true,
    });
  }

  private async inspectPlacementContainer(nodeId: string, containerId: string): Promise<Record<string, any>> {
    const inspected = await this.dispatch.sendDockerContainerCommand(nodeId, 'inspect', { containerId });
    if (!inspected.success) {
      throw new AppError(
        502,
        'AVAILABILITY_CONTAINER_INSPECT_FAILED',
        inspected.error || 'Container inspection failed'
      );
    }
    return parseStrictDetail(
      inspected.detail,
      'AVAILABILITY_CONTAINER_INSPECT_INVALID',
      'Container inspection returned an invalid response'
    );
  }

  private async waitUntilStopped(context: DockerAvailabilityAdapterContext, containerId: string): Promise<void> {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      await this.fence(context);
      try {
        const inspect = await this.inspectPlacementContainer(context.nodeId, containerId);
        const state = inspect.State ?? {};
        if (state.Running === false && state.Paused !== true && state.Restarting !== true) return;
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AppError(409, 'AVAILABILITY_CONTAINER_STOP_TIMEOUT', 'Waiting for the container to finish stopping', {
      retryable: true,
    });
  }

  async startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    await this.claimAndFence(context);
    const inspect = await this.inspectPlacementContainer(
      context.nodeId,
      String(prior.runtimeIdentity?.containerId ?? placementContainerRuntimeName(context))
    );
    const owner = availabilityPlacementOwner(inspect);
    const hasOwner = Boolean(owner.policyId || owner.placementId);
    if (
      (hasOwner && (owner.policyId !== context.policyId || owner.placementId !== context.placementId)) ||
      (!hasOwner && context.nodeId !== context.resource.currentNodeId) ||
      (availabilityPlacementGeneration(inspect) ?? context.generation) > context.generation
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_CONTAINER_NAME_CONFLICT',
        'The existing container is owned by another workload'
      );
    }
    const runtimeIdentity = {
      containerId: String(inspect.Id ?? inspect.id),
      containerName: String(inspect.Name ?? inspect.name ?? placementContainerRuntimeName(context)).replace(/^\/+/, ''),
    };
    await this.projector.prepare(context);
    await this.fence(context);
    const started = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'start', {
      containerId: runtimeIdentity.containerId,
    });
    if (!started.success)
      throw new AppError(502, 'AVAILABILITY_CONTAINER_START_FAILED', started.error || 'Container start failed');
    await context.reportProgress?.('checking_health', 'Waiting for the existing container to become healthy');
    await this.waitUntilReady(context.nodeId, runtimeIdentity.containerId);
    await this.fence(context);
    const active = await this.daemon(context, 'activate', { runtimeIdentity });
    return this.activateResult(context, this.result(context, active, runtimeIdentity, context.resource.imageReference));
  }

  async stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    await this.claimAndFence(context);
    await this.fence(context);
    await this.projector.deactivate?.(context);
    const containerId = String(prior.runtimeIdentity?.containerId ?? placementContainerRuntimeName(context));
    let inspect: Record<string, any> | null = null;
    try {
      inspect = await this.inspectPlacementContainer(context.nodeId, containerId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    if (inspect && context.nodeId !== context.resource.currentNodeId) {
      const owner = availabilityPlacementOwner(inspect);
      if (owner.policyId !== context.policyId || owner.placementId !== context.placementId) {
        throw new AppError(
          409,
          'AVAILABILITY_CONTAINER_NAME_CONFLICT',
          'The placement container to stop is owned by another workload'
        );
      }
    }
    const runtimeIdentity = inspect
      ? {
          containerId: String(inspect.Id ?? inspect.id ?? containerId),
          containerName: String(inspect.Name ?? inspect.name ?? placementContainerRuntimeName(context)).replace(
            /^\/+/,
            ''
          ),
        }
      : { containerId, containerName: placementContainerRuntimeName(context) };
    if (inspect && ((inspect.State ?? {}) as Record<string, unknown>).Running === true) {
      await this.fence(context);
      const stopped = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'stop', {
        containerId: runtimeIdentity.containerId,
        timeoutSeconds: 30,
      });
      if (!stopped.success && !/not running|already stopped|not found|no such/i.test(stopped.error ?? '')) {
        throw new AppError(502, 'AVAILABILITY_CONTAINER_STOP_FAILED', stopped.error || 'Container stop failed');
      }
      // The daemon acknowledges stop before Docker finishes it. Restart must
      // not start/read health from that still-running, soon-to-stop process.
      await context.reportProgress?.('draining', 'Waiting for the existing container to finish stopping');
      await this.waitUntilStopped(context, runtimeIdentity.containerId);
    }
    await this.fence(context);
    const stopped = await this.daemon(context, 'stop', { runtimeIdentity });
    return this.stoppedResult(context, stopped, runtimeIdentity, context.resource.imageReference);
  }

  async drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void> {
    await this.claimAndFence(context);
    await this.fence(context);
    await this.projector.deactivate?.(context);
    await this.fence(context);
    await this.daemon(context, 'drain', { drainSeconds });
    if (drainSeconds > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(drainSeconds, 30) * 1000));
  }

  async removePlacement(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'removed') {
      await this.fence(context);
      await this.projector.cleanup(context);
      return;
    }
    await this.claimAndFence(context);
    let containerId = String(prior.runtimeIdentity?.containerId ?? placementContainerRuntimeName(context));
    let inspect: Record<string, any> | null = null;
    let interruptedAdoption = false;
    try {
      inspect = await this.inspectPlacementContainer(context.nodeId, containerId);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    if (!inspect && context.nodeId !== context.resource.currentNodeId) {
      try {
        const staged = await this.inspectPlacementContainer(context.nodeId, context.resource.displayName);
        const owner = availabilityPlacementOwner(staged);
        const generation = availabilityPlacementGeneration(staged);
        const hasAvailabilityIdentity = Boolean(owner.policyId || owner.placementId || generation !== null);
        const ownedByPlacement =
          owner.policyId === context.policyId &&
          owner.placementId === context.placementId &&
          generation !== null &&
          generation <= context.generation;
        if (
          (hasAvailabilityIdentity && !ownedByPlacement) ||
          (!hasAvailabilityIdentity &&
            !containerCanonicalSpecMatches(staged, context, context.resource.displayName, false, true))
        ) {
          throw new AppError(
            409,
            'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
            'The interrupted adoption container does not match the claimed Availability identity'
          );
        }
        inspect = staged;
        interruptedAdoption = true;
        containerId = String(staged.Id ?? staged.id ?? context.resource.displayName);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    if (inspect) {
      const requireAvailabilityIdentity = context.nodeId !== context.resource.currentNodeId;
      if (requireAvailabilityIdentity) {
        if (!interruptedAdoption) {
          const owner = availabilityPlacementOwner(inspect);
          if (owner.policyId !== context.policyId || owner.placementId !== context.placementId) {
            throw new AppError(
              409,
              'AVAILABILITY_CONTAINER_NAME_CONFLICT',
              'The deterministic placement container name is already in use'
            );
          }
          const generation = availabilityPlacementGeneration(inspect);
          if (generation === null || generation > context.generation) {
            throw new AppError(
              409,
              'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
              'The placement container generation cannot be removed by this operation'
            );
          }
        }
      } else {
        const owner = availabilityPlacementOwner(inspect);
        const generation = availabilityPlacementGeneration(inspect);
        const hasAvailabilityIdentity = Boolean(owner.policyId || owner.placementId || generation !== null);
        const ownedByPlacement =
          owner.policyId === context.policyId &&
          owner.placementId === context.placementId &&
          generation !== null &&
          generation <= context.generation;
        if (
          (hasAvailabilityIdentity && !ownedByPlacement) ||
          (!hasAvailabilityIdentity &&
            !containerCanonicalSpecMatches(inspect, context, placementContainerRuntimeName(context), false, true))
        ) {
          throw new AppError(
            409,
            'AVAILABILITY_CONTAINER_IDENTITY_CONFLICT',
            'The container to remove does not match the claimed Availability identity'
          );
        }
      }
    }
    await this.fence(context);
    if (inspect) {
      const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
        containerId,
        force: true,
      });
      if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
        throw new AppError(503, 'AVAILABILITY_CONTAINER_CLEANUP_PENDING', removed.error || 'Container removal failed', {
          retryable: true,
        });
      }
    }
    await this.fence(context);
    await this.projector.cleanup(context);
    await this.fence(context);
    await this.daemon(context, 'remove');
  }

  async adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'single') {
      await this.fence(context);
      await this.projector.adopt?.(context);
      return;
    }
    await this.claimAndFence(context);
    const containerId = String(prior.runtimeIdentity?.containerId ?? placementContainerRuntimeName(context));
    let existing: Record<string, any> | null = null;
    try {
      existing = await this.inspectPlacementContainer(context.nodeId, containerId);
    } catch (error) {
      if (context.resource.running || !isNotFoundError(error)) throw error;
    }
    const owner = existing ? availabilityPlacementOwner(existing) : { policyId: '', placementId: '' };
    const generation = existing ? availabilityPlacementGeneration(existing) : null;
    const hasAvailabilityIdentity = Boolean(owner.policyId || owner.placementId || generation !== null);
    const requireAvailabilityIdentity = context.nodeId !== context.resource.currentNodeId || hasAvailabilityIdentity;
    if (existing && requireAvailabilityIdentity) {
      if (
        owner.policyId !== context.policyId ||
        owner.placementId !== context.placementId ||
        generation === null ||
        generation > context.generation
      ) {
        throw new AppError(
          409,
          'AVAILABILITY_CONTAINER_NAME_CONFLICT',
          'The surviving placement container is owned by another workload'
        );
      }
    }
    const existingImageReference = String(existing?.Config?.Image ?? existing?.config?.image ?? '').trim();
    // Older placement rows could retain the pre-mirror fingerprint after a
    // successful heal. Reconstruct only the exact, recorded immutable image's
    // prepared spec; never adopt an arbitrary label as the expected identity.
    const preparedFingerprint =
      existing &&
      requireAvailabilityIdentity &&
      isDigestPinnedImageReference(existingImageReference) &&
      existingImageReference === context.resource.imageReference
        ? fingerprint({ ...context.resource.portableSpec, image: existingImageReference })
        : null;
    const expectedFingerprint =
      preparedFingerprint && existing && availabilityPlacementSpecFingerprint(existing) === preparedFingerprint
        ? preparedFingerprint
        : context.resource.specFingerprint;
    const validationContext =
      existing && requireAvailabilityIdentity && isDigestPinnedImageReference(existingImageReference)
        ? {
            ...context,
            resource: {
              ...context.resource,
              imageReference: existingImageReference,
              specFingerprint: expectedFingerprint,
            },
          }
        : context;
    if (
      existing &&
      !containerCanonicalSpecMatches(
        existing,
        validationContext,
        placementContainerRuntimeName(context),
        requireAvailabilityIdentity,
        true
      )
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_SINGLE_ADOPTION_IDENTITY_UNVERIFIED',
        'The surviving container does not match the claimed canonical spec or immutable image'
      );
    }
    const spec = context.resource.portableSpec as Record<string, any>;
    const adoptedImageReference = String(
      context.resource.sourceImageReference ?? spec.sourceImageReference ?? spec.image ?? ''
    ).trim();
    if (
      existing &&
      existingImageReference &&
      adoptedImageReference &&
      existingImageReference !== adoptedImageReference &&
      !isDigestPinnedImageReference(adoptedImageReference)
    ) {
      const tagged = await this.dispatch.sendDockerImageCommand(context.nodeId, 'tag', {
        imageRef: existingImageReference,
        targetImageRef: adoptedImageReference,
      });
      if (!tagged.success) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_IMAGE_TAG_FAILED',
          tagged.error || 'The surviving image could not be restored to its source tag'
        );
      }
    }
    const dependencies = await this.projector.prepare(context);
    const [env, secrets] = await Promise.all([
      this.environment.getDecryptedMap(context.resource.currentNodeId, context.resource.displayName),
      this.secrets.getDecryptedMap(context.resource.currentNodeId, context.resource.displayName),
    ]);
    const stagedAdoption = Boolean(existing && placementContainerRuntimeName(context) !== context.resource.displayName);
    await this.fence(context);
    if (existing && !stagedAdoption) {
      const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
        containerId,
        force: true,
      });
      if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_REMOVE_FAILED',
          removed.error || 'Container cleanup failed'
        );
      }
    }
    const runtimeSpec = availabilityContainerRuntimeSpec(spec);
    const singleSpec: Record<string, any> = {
      ...runtimeSpec,
      image: adoptedImageReference || context.resource.imageReference || spec.image,
    };
    await this.fence(context);
    const created = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'create', {
      configJson: JSON.stringify({
        ...singleSpec,
        name: context.resource.displayName,
        env: Object.entries({ ...env, ...secrets, ...dependencies.environment }).map(
          ([key, value]) => `${key}=${value}`
        ),
        network_mode: dependencies.networkNames[0],
        extra_hosts: Object.entries(dependencies.extraHosts).map(([host, address]) => `${host}:${address}`),
        labels: sanitizedLabels(singleSpec.labels),
      }),
    });
    if (!created.success) {
      throw new AppError(
        502,
        'AVAILABILITY_SINGLE_ADOPTION_CREATE_FAILED',
        created.error || 'Single-node container recreation failed'
      );
    }
    const createdIdentity = parseDetail(created.detail);
    const nextContainerId = String(createdIdentity.id ?? createdIdentity.Id ?? context.resource.displayName);
    for (const networkName of dependencies.networkNames.slice(1)) {
      await this.fence(context);
      const connected = await this.dispatch.sendDockerNetworkCommand(context.nodeId, 'connect', {
        networkId: networkName,
        containerId: nextContainerId,
      });
      if (!connected.success && !/already|exists/i.test(connected.error ?? '')) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_NETWORK_FAILED',
          connected.error || 'Single-node database network connect failed'
        );
      }
    }
    if (context.resource.running) {
      await this.fence(context);
      const started = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'start', {
        containerId: nextContainerId,
      });
      if (!started.success) {
        throw new AppError(502, 'AVAILABILITY_SINGLE_ADOPTION_START_FAILED', started.error || 'Container start failed');
      }
      await this.waitUntilReady(context.nodeId, nextContainerId);
    }
    await this.fence(context);
    await this.environment.replace(context.nodeId, context.resource.displayName, env);
    await this.fence(context);
    await this.secrets.replaceImported(context.nodeId, context.resource.displayName, secrets, 'system');
    if (existing && stagedAdoption) {
      await this.fence(context);
      await this.projector.prepareFinalAdoption?.(context);
      await this.fence(context);
      await this.projector.finalizeAdoption?.(context);
      await this.fence(context);
      const removed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'remove', {
        containerId,
        force: true,
      });
      if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_REMOVE_FAILED',
          removed.error || 'Container cleanup failed'
        );
      }
    }
    await this.fence(context);
    await this.projector.adopt?.(context);
    await this.fence(context);
    await this.daemon(context, 'adopt_single', {
      runtimeIdentity: { containerId: nextContainerId, containerName: context.resource.displayName },
    });
  }
}

export class DockerDeploymentAvailabilityAdapter extends BaseAvailabilityAdapter implements DockerAvailabilityAdapter {
  readonly kind = 'deployment' as const;

  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    private readonly secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  ) {
    super(db, dispatch, projector);
  }

  async resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource> {
    if (resource.type !== 'deployment')
      throw new AppError(400, 'AVAILABILITY_RESOURCE_KIND_MISMATCH', 'Deployment expected');
    const [deployment] = await this.db
      .select()
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, resource.deploymentId))
      .limit(1);
    if (!deployment) throw new AppError(404, 'DOCKER_DEPLOYMENT_NOT_FOUND', 'Docker deployment not found');
    const [routes, slots] = await Promise.all([
      this.db.select().from(dockerDeploymentRoutes).where(eq(dockerDeploymentRoutes.deploymentId, deployment.id)),
      this.db.select().from(dockerDeploymentSlots).where(eq(dockerDeploymentSlots.deploymentId, deployment.id)),
    ]);
    const sourceImageReference = String(deployment.desiredConfig.image ?? '').trim();
    const desiredConfig = { ...deployment.desiredConfig, networks: [] };
    const portableSpec = {
      name: deployment.name,
      sourceImageReference,
      desiredConfig,
      health: deployment.healthConfig,
      routerImage: deployment.routerImage,
      routerName: deployment.routerName,
      networkName: deployment.networkName,
      activeSlot: deployment.activeSlot,
      routes: routes.map((route) => ({ ...route, hostIp: '127.0.0.1' })),
      slots: Object.fromEntries(slots.map((slot) => [slot.slot, slot.containerName])),
    };
    const inspected = await this.dispatch.sendDockerDeploymentCommand(deployment.nodeId, 'inspect', {
      deploymentId: deployment.id,
    });
    if (!inspected.success) {
      throw new AppError(
        502,
        'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
        inspected.error || 'Deployment inspection failed'
      );
    }
    const runtime = parseStrictDetail(
      inspected.detail,
      'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
      'Deployment inspection returned an invalid response'
    );
    const activeContainer = (Array.isArray(runtime.containers) ? runtime.containers : []).find(
      (container: Record<string, any>) => {
        const labels = (container.labels ?? container.Labels ?? {}) as Record<string, unknown>;
        return (
          labels['wiolett.gateway.deployment.role'] === 'app' &&
          labels['wiolett.gateway.deployment.slot'] === deployment.activeSlot
        );
      }
    ) as Record<string, any> | undefined;
    const runtimeImage = String(activeContainer?.imageId ?? activeContainer?.ImageID ?? '');
    const imageReference = /^sha256:[0-9a-f]{64}$/i.test(runtimeImage) ? runtimeImage : desiredConfig.image;
    if (isDigestPinnedImageReference(imageReference)) desiredConfig.image = imageReference;
    return {
      kind: 'deployment',
      reference: resource,
      resourceId: deployment.id,
      displayName: deployment.name,
      currentNodeId: deployment.nodeId,
      viewScope: 'docker:containers:view',
      manageScope: 'docker:containers:manage',
      specFingerprint: fingerprint(portableSpec),
      portableSpec,
      imageReference,
      sourceImageReference,
      running: deployment.status !== 'stopped',
    };
  }

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ) {
    const spec = resource.portableSpec as Record<string, any>;
    const blockers = [] as DockerAvailabilityAdapterPreflight['blockers'];
    if ((spec.desiredConfig?.mounts?.length ?? 0) > 0) {
      blockers.push({
        code: 'AVAILABILITY_MOUNTS_UNSUPPORTED',
        message: 'Deployments with any mount cannot use Availability',
      });
    }
    return this.combinedPreflight(resource, candidateNodes, blockers, scopes);
  }

  private runtime(context: DockerAvailabilityAdapterContext) {
    const spec = context.resource.portableSpec as Record<string, any>;
    if (context.nodeId === context.resource.currentNodeId) {
      return {
        deploymentId: context.resource.resourceId,
        routerName: String(spec.routerName ?? ''),
        networkName: String(spec.networkName ?? ''),
        slots: spec.slots as { blue: string; green: string },
      };
    }
    const base = internalName('deployment', context);
    return {
      deploymentId: context.resource.resourceId,
      routerName: `${base}-router`,
      networkName: `${base}-net`,
      slots: { blue: `${base}-blue`, green: `${base}-green` },
    };
  }

  private async removeRuntime(
    context: DockerAvailabilityAdapterContext,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): Promise<void> {
    await this.fence(context);
    const inspected = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'inspect', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({ deployment: deploymentAvailabilitySnapshot(context, runtime) }),
    });
    if (!inspected.success) {
      throw new AppError(
        502,
        'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
        inspected.error || 'Deployment cleanup inspection failed'
      );
    }
    const observed = parseStrictDetail(
      inspected.detail,
      'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
      'Deployment cleanup inspection returned an invalid response'
    );
    const containers = observed.containers;
    if (this.runtimeHasForeignCollision(containers, runtime)) {
      throw new AppError(
        409,
        'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
        'Deterministic deployment runtime names are already owned by another workload'
      );
    }
    if (
      Array.isArray(containers) &&
      containers.length > 0 &&
      !this.runtimeRemovalOwnershipIsValid(context, containers, runtime)
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_DEPLOYMENT_IDENTITY_CONFLICT',
        'The deployment runtime does not match the claimed Availability identity'
      );
    }
    await this.fence(context);
    const removed = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'remove', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({
        deployment: deploymentAvailabilitySnapshot(context, runtime),
      }),
      force: true,
    });
    if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
      throw new AppError(503, 'AVAILABILITY_DEPLOYMENT_CLEANUP_PENDING', removed.error || 'Deployment removal failed', {
        retryable: true,
      });
    }
  }

  async ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    const priorGeneration = Number(prior.generation ?? 0);
    await this.claimAndFence(context);
    await context.reportProgress?.('preparing_dependencies', 'Preparing deployment database links and networks');
    const dependencies = await this.projector.prepare(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const runtime = this.runtime(context);
    const deploymentSecrets = await this.secrets.getDecryptedMap(
      context.resource.currentNodeId,
      `deployment:${context.resource.resourceId}`
    );
    const placementDesiredConfig = {
      ...spec.desiredConfig,
      env: { ...(spec.desiredConfig?.env ?? {}), ...deploymentSecrets, ...dependencies.environment },
      networks: dependencies.networkNames,
      extraHosts: Object.entries(dependencies.extraHosts).map(([host, address]) => `${host}:${address}`),
      labels:
        context.nodeId === context.resource.currentNodeId
          ? {
              ...sanitizedLabels(spec.desiredConfig?.labels),
              [availabilitySpecFingerprintLabel]: context.resource.specFingerprint,
            }
          : availabilityPlacementLabels(context, spec.desiredConfig?.labels),
    };
    let runtimeRemoved = false;
    if (priorGeneration > 0 && priorGeneration <= context.generation) {
      const inspected = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'inspect', {
        deploymentId: runtime.deploymentId,
        configJson: JSON.stringify({ deployment: deploymentAvailabilitySnapshot(context, runtime) }),
      });
      if (!inspected.success) {
        throw new AppError(
          502,
          'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
          inspected.error || 'Deployment rollout inspection failed'
        );
      }
      const observed = parseStrictDetail(
        inspected.detail,
        'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
        'Deployment rollout inspection returned an invalid response'
      );
      const snapshot = deploymentPlacementSnapshot(
        spec,
        runtime,
        placementDesiredConfig,
        observed,
        prior.runtimeIdentity
      );
      let activeSlot = snapshot.activeSlot;
      if (
        context.nodeId !== context.resource.currentNodeId &&
        this.runtimeHasForeignCollision(observed.containers, runtime)
      ) {
        throw new AppError(
          409,
          'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
          'Deterministic deployment runtime names are already owned by another workload'
        );
      }
      if (!this.runtimeOwnershipIsValid(context, observed.containers, runtime, activeSlot, true, true, true)) {
        await this.removeRuntime(context, runtime);
        runtimeRemoved = true;
      } else {
        const requestedSlot =
          context.targetActiveSlot ??
          (priorGeneration === context.generation ? activeSlot : activeSlot === 'blue' ? 'green' : 'blue');
        if (
          requestedSlot === activeSlot &&
          this.activeSlotMatchesDesired(context, observed.containers, runtime, activeSlot)
        ) {
          const runtimeIdentity = { ...runtime, ...prior.runtimeIdentity, activeSlot };
          await this.fence(context);
          const active = await this.daemon(context, 'activate', { runtimeIdentity });
          return this.activateResult(
            context,
            this.result(context, active, runtimeIdentity, context.resource.imageReference)
          );
        }
        // Never recreate the slot currently carrying traffic. If a failed
        // rollout left the requested target active with an old revision, bridge
        // through the other slot and finish on the explicitly requested target.
        const slots =
          requestedSlot === activeSlot ? [activeSlot === 'blue' ? 'green' : 'blue', requestedSlot] : [requestedSlot];
        let deployedIdentity: Record<string, unknown> = {};
        for (const toSlot of slots) {
          await this.fence(context);
          await context.reportProgress?.(
            'starting',
            `Creating ${toSlot} candidate and waiting for deployment health checks`
          );
          const deployed = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'deploy_slot', {
            deploymentId: runtime.deploymentId,
            slot: toSlot,
            configJson: JSON.stringify({ deployment: snapshot, toSlot, desiredConfig: placementDesiredConfig }),
          });
          if (!deployed.success) {
            throw new AppError(
              409,
              'AVAILABILITY_DEPLOYMENT_ROLLOUT_FAILED',
              deployed.error || 'Deployment candidate failed readiness',
              {
                retryable: true,
              }
            );
          }
          await this.fence(context);
          await context.reportProgress?.('activating_routes', `Switching deployment traffic to ${toSlot}`);
          const switched = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'switch', {
            deploymentId: runtime.deploymentId,
            slot: toSlot,
            configJson: JSON.stringify({ deployment: snapshot, activeSlot: toSlot }),
          });
          if (!switched.success) {
            throw new AppError(
              409,
              'AVAILABILITY_DEPLOYMENT_SWITCH_FAILED',
              switched.error || 'Deployment traffic switch failed',
              {
                retryable: true,
              }
            );
          }
          deployedIdentity = { ...parseDetail(deployed.detail), ...parseDetail(switched.detail) };
          // A stop failure can leave both slots running. Persist the switched
          // target so retry does not mistake the old running slot for the router's
          // active target and recreate the slot that is carrying traffic.
          await this.daemon(
            { ...context, idempotencyKey: `${context.idempotencyKey}:switched:${toSlot}` },
            'activate',
            {
              runtimeIdentity: { ...runtime, ...deployedIdentity, activeSlot: toSlot },
            }
          );
          await this.fence(context);
          await context.reportProgress?.('stopping', `Stopping previous ${activeSlot} slot`);
          const stopped = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'stop_slot', {
            deploymentId: runtime.deploymentId,
            slot: activeSlot,
            configJson: JSON.stringify({ deployment: snapshot, slot: activeSlot }),
          });
          if (!stopped.success && !/not found|no such/i.test(stopped.error ?? '')) {
            throw new AppError(
              409,
              'AVAILABILITY_DEPLOYMENT_STOP_FAILED',
              stopped.error || 'Deployment old slot stop failed',
              { retryable: true }
            );
          }
          activeSlot = toSlot as 'blue' | 'green';
          snapshot.activeSlot = activeSlot;
        }
        const runtimeIdentity = { ...runtime, ...deployedIdentity, activeSlot };
        await this.fence(context);
        const active = await this.daemon(context, 'activate', { runtimeIdentity });
        return this.activateResult(
          context,
          this.result(context, active, runtimeIdentity, context.resource.imageReference)
        );
      }
    }
    if (context.nodeId === context.resource.currentNodeId || priorGeneration === context.generation) {
      const inspected = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'inspect', {
        deploymentId: runtime.deploymentId,
        configJson: JSON.stringify({ deployment: deploymentAvailabilitySnapshot(context, runtime) }),
      });
      if (!inspected.success && context.nodeId === context.resource.currentNodeId) {
        throw new AppError(
          502,
          'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
          inspected.error || 'Origin deployment inspection failed'
        );
      }
      if (inspected.success) {
        const observed = parseStrictDetail(
          inspected.detail,
          'AVAILABILITY_DEPLOYMENT_INSPECT_FAILED',
          'Deployment inspection returned an invalid response'
        );
        const activeSlot = observedDeploymentActiveSlot(
          observed.containers,
          runtime,
          String(prior.runtimeIdentity?.activeSlot ?? spec.activeSlot ?? 'blue')
        );
        if (
          (!context.targetActiveSlot || context.targetActiveSlot === activeSlot) &&
          this.activeSlotMatchesDesired(context, observed.containers, runtime, activeSlot)
        ) {
          const runtimeIdentity = { ...runtime, ...prior.runtimeIdentity, activeSlot };
          await this.fence(context);
          const active = await this.daemon(context, 'activate', { runtimeIdentity });
          return this.activateResult(
            context,
            this.result(context, active, runtimeIdentity, context.resource.imageReference)
          );
        }
      }
      if (context.nodeId === context.resource.currentNodeId && !runtimeRemoved) {
        await this.removeRuntime(context, runtime);
        runtimeRemoved = true;
      }
    }
    const payload = {
      ...spec,
      activeSlot: context.targetActiveSlot ?? spec.activeSlot,
      desiredConfig: {
        ...placementDesiredConfig,
      },
      ...runtime,
      deploymentId: runtime.deploymentId,
    };
    if (priorGeneration === context.generation && !runtimeRemoved) {
      await this.removeRuntime(context, runtime);
    }
    await this.fence(context);
    await context.reportProgress?.('starting', 'Creating deployment slots and waiting for readiness');
    const created = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'create', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify(payload),
    });
    if (!created.success && !/already|conflict|exists/i.test(created.error ?? '')) {
      throw new AppError(502, 'AVAILABILITY_DEPLOYMENT_CREATE_FAILED', created.error || 'Deployment placement failed');
    }
    const activeSlot = await this.verifyRuntimeOwnership(context, runtime, String(payload.activeSlot ?? 'blue'));
    const runtimeIdentity = { ...runtime, ...parseDetail(created.detail), activeSlot };
    await this.fence(context);
    const active = await this.daemon(context, 'activate', { runtimeIdentity });
    return this.activateResult(context, this.result(context, active, runtimeIdentity, context.resource.imageReference));
  }

  private activeSlotMatchesDesired(
    context: DockerAvailabilityAdapterContext,
    containers: unknown,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>,
    activeSlot: string
  ): boolean {
    if (!this.runtimeOwnershipIsValid(context, containers, runtime, activeSlot, true, true, true)) return false;
    const rows = Array.isArray(containers) ? (containers as Array<Record<string, any>>) : [];
    const active = rows.find((row) => deploymentRowName(row) === runtime.slots[activeSlot as 'blue' | 'green']);
    // Ownership of an older revision permits replacement, never acknowledgement
    // of the desired image/config. The origin needs the same spec proof as peers.
    return Boolean(
      active &&
        this.runtimeRowIdentityIsValid(context, active, false) &&
        deploymentRowLabels(active)[availabilitySpecFingerprintLabel] === context.resource.specFingerprint
    );
  }

  private async verifyRuntimeOwnership(
    context: DockerAvailabilityAdapterContext,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>,
    activeSlot: string,
    allowStaleGeneration = false,
    lifecycle = false
  ): Promise<'blue' | 'green'> {
    const inspected = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'inspect', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({ deployment: deploymentAvailabilitySnapshot(context, runtime) }),
    });
    if (!inspected.success) {
      throw new AppError(
        502,
        'AVAILABILITY_DEPLOYMENT_OWNERSHIP_UNVERIFIED',
        inspected.error || 'Deployment placement ownership could not be verified'
      );
    }
    const observed = parseStrictDetail(
      inspected.detail,
      'AVAILABILITY_DEPLOYMENT_OWNERSHIP_UNVERIFIED',
      'Deployment placement ownership returned an invalid response'
    );
    const observedActiveSlot = observedDeploymentActiveSlot(observed.containers, runtime, activeSlot);
    if (
      !this.runtimeOwnershipIsValid(
        context,
        observed.containers,
        runtime,
        observedActiveSlot,
        allowStaleGeneration,
        true,
        lifecycle
      )
    ) {
      throw new AppError(
        409,
        'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
        'Deterministic deployment runtime names are already owned by another workload'
      );
    }
    return observedActiveSlot;
  }

  private runtimeOwnershipIsValid(
    context: DockerAvailabilityAdapterContext,
    containers: unknown,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>,
    activeSlot: string,
    allowStaleGeneration = false,
    requireRunning = true,
    lifecycle = false
  ): boolean {
    const rows = Array.isArray(containers) ? (containers as Array<Record<string, any>>) : [];
    const expectedNames = new Set([runtime.routerName, runtime.slots.blue, runtime.slots.green]);
    if (this.runtimeHasForeignCollision(rows, runtime)) return false;
    const owned = rows.filter((row) => {
      const labels = deploymentRowLabels(row);
      return labels['wiolett.gateway.deployment.id'] === runtime.deploymentId;
    });
    const hasRouter = owned.some((row) => {
      const labels = deploymentRowLabels(row);
      return (
        labels['wiolett.gateway.deployment.role'] === 'router' &&
        String(row.name ?? row.Name ?? '') === runtime.routerName &&
        (!requireRunning || deploymentContainerIsRunning(row))
      );
    });
    const hasActiveSlot = owned.some((row) => {
      const labels = deploymentRowLabels(row);
      return (
        labels['wiolett.gateway.deployment.role'] === 'app' &&
        labels['wiolett.gateway.deployment.slot'] === activeSlot &&
        String(row.name ?? row.Name ?? '') === runtime.slots[activeSlot as 'blue' | 'green'] &&
        (!requireRunning || deploymentContainerIsRunning(row))
      );
    });
    const hasUnexpectedName = owned.some((row) => !expectedNames.has(deploymentRowName(row)));
    if (!hasRouter || !hasActiveSlot || hasUnexpectedName) return false;
    if (lifecycle) return this.runtimeRemovalOwnershipIsValid(context, rows, runtime);
    return owned.every((row) => this.runtimeRowIdentityIsValid(context, row, allowStaleGeneration));
  }

  private runtimeHasForeignCollision(
    containers: unknown,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): boolean {
    const expectedNames = new Set([runtime.routerName, runtime.slots.blue, runtime.slots.green]);
    return (Array.isArray(containers) ? (containers as Array<Record<string, any>>) : []).some((row) => {
      if (!expectedNames.has(deploymentRowName(row))) return false;
      return deploymentRowLabels(row)['wiolett.gateway.deployment.id'] !== runtime.deploymentId;
    });
  }

  private runtimeRemovalOwnershipIsValid(
    context: DockerAvailabilityAdapterContext,
    containers: unknown,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): boolean {
    const rows = Array.isArray(containers) ? (containers as Array<Record<string, any>>) : [];
    const expectedNames = new Set([runtime.routerName, runtime.slots.blue, runtime.slots.green]);
    return rows.every((row) => {
      if (!expectedNames.has(deploymentRowName(row))) return true;
      const labels = deploymentRowLabels(row);
      if (labels['wiolett.gateway.deployment.id'] !== runtime.deploymentId) return false;
      return (
        this.runtimeRowIdentityIsValid(context, row, true) ||
        this.originRuntimeRowIsSafelyRemovable(context, row, runtime) ||
        this.staleRuntimeRowIsSafelyRemovable(context, row, runtime) ||
        this.legacyRuntimeRowIsSafelyRemovable(context, row, runtime)
      );
    });
  }

  private originRuntimeRowIsSafelyRemovable(
    context: DockerAvailabilityAdapterContext,
    row: Record<string, any>,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): boolean {
    if (context.nodeId !== context.resource.currentNodeId) return false;
    const labels = deploymentRowLabels(row);
    if (
      labels['wiolett.gateway.deployment.id'] !== runtime.deploymentId ||
      labels['wiolett.gateway.deployment.managed'] !== 'true'
    ) {
      return false;
    }
    const name = deploymentRowName(row);
    const role = String(labels['wiolett.gateway.deployment.role'] ?? '');
    if (name === runtime.routerName) return role === 'router' && immutableRuntimeRowHasImageId(row);
    const slot = name === runtime.slots.blue ? 'blue' : name === runtime.slots.green ? 'green' : '';
    return Boolean(slot) && role === 'app' && labels['wiolett.gateway.deployment.slot'] === slot;
  }

  private staleRuntimeRowIsSafelyRemovable(
    context: DockerAvailabilityAdapterContext,
    row: Record<string, any>,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): boolean {
    if (context.nodeId === context.resource.currentNodeId) return false;
    const labels = deploymentRowLabels(row);
    if (labels['wiolett.gateway.deployment.managed'] !== 'true') return false;
    const name = deploymentRowName(row);
    const role = String(labels['wiolett.gateway.deployment.role'] ?? '');
    if (name === runtime.routerName) {
      return role === 'router' && immutableRuntimeRowHasImageId(row);
    }
    const slot = name === runtime.slots.blue ? 'blue' : name === runtime.slots.green ? 'green' : '';
    const generation = Number(labels[availabilityGenerationLabel]);
    return (
      Boolean(slot) &&
      role === 'app' &&
      labels['wiolett.gateway.deployment.slot'] === slot &&
      labels['wiolett.gateway.availability.policy'] === context.policyId &&
      labels['wiolett.gateway.availability.placement'] === context.placementId &&
      Number.isInteger(generation) &&
      generation > 0 &&
      generation <= context.generation
    );
  }

  private legacyRuntimeRowIsSafelyRemovable(
    context: DockerAvailabilityAdapterContext,
    row: Record<string, any>,
    runtime: ReturnType<DockerDeploymentAvailabilityAdapter['runtime']>
  ): boolean {
    if (context.nodeId === context.resource.currentNodeId) return false;
    const labels = deploymentRowLabels(row);
    const availabilityIdentity = [
      labels['wiolett.gateway.availability.policy'],
      labels['wiolett.gateway.availability.placement'],
      labels[availabilityGenerationLabel],
      labels[availabilitySpecFingerprintLabel],
    ];
    if (availabilityIdentity.some((value) => value !== undefined && String(value) !== '')) return false;
    if (labels['wiolett.gateway.deployment.managed'] !== 'true') return false;
    const name = deploymentRowName(row);
    const role = String(labels['wiolett.gateway.deployment.role'] ?? '');
    if (name === runtime.routerName) {
      return role === 'router' && immutableRuntimeRowHasImageId(row);
    }
    const slot = name === runtime.slots.blue ? 'blue' : name === runtime.slots.green ? 'green' : '';
    if (!slot || role !== 'app' || labels['wiolett.gateway.deployment.slot'] !== slot) return false;
    const spec = context.resource.portableSpec as Record<string, any>;
    return immutableRuntimeRowImageMatches(row, context.resource.imageReference ?? spec.desiredConfig?.image);
  }

  private runtimeRowIdentityIsValid(
    context: DockerAvailabilityAdapterContext,
    row: Record<string, any>,
    allowStaleGeneration: boolean
  ): boolean {
    const labels = deploymentRowLabels(row);
    const role = String(labels['wiolett.gateway.deployment.role'] ?? '');
    const spec = context.resource.portableSpec as Record<string, any>;
    // A rollout owns the old generation even when its image/config differs
    // from the desired one. Comparing it to the NEW spec turns a normal
    // blue/green update into destructive removal of the whole deployment.
    if (allowStaleGeneration && role === 'app') {
      if (!immutableRuntimeRowHasImageId(row)) return false;
      if (context.nodeId === context.resource.currentNodeId) {
        return labels['wiolett.gateway.deployment.managed'] === 'true';
      }
      const generation = Number(labels[availabilityGenerationLabel]);
      if (Number.isInteger(generation) && generation > 0 && generation < context.generation) {
        return (
          labels['wiolett.gateway.availability.policy'] === context.policyId &&
          labels['wiolett.gateway.availability.placement'] === context.placementId
        );
      }
    }
    if (role === 'app') {
      const expectedImages = [context.resource.imageReference, spec.desiredConfig?.image].filter(Boolean);
      if (!expectedImages.some((expectedImage) => immutableRuntimeRowImageMatches(row, expectedImage))) return false;
    } else if (role === 'router') {
      if (!immutableRuntimeRowHasImageId(row)) return false;
    } else {
      return false;
    }
    if (context.nodeId === context.resource.currentNodeId) return true;
    if (role === 'router') return true;
    const generation = Number(labels[availabilityGenerationLabel]);
    return (
      labels['wiolett.gateway.availability.policy'] === context.policyId &&
      labels['wiolett.gateway.availability.placement'] === context.placementId &&
      Number.isInteger(generation) &&
      generation > 0 &&
      (allowStaleGeneration ? generation <= context.generation : generation === context.generation) &&
      (role !== 'app' || String(labels[availabilitySpecFingerprintLabel] ?? '') === context.resource.specFingerprint)
    );
  }

  async drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void> {
    await this.claimAndFence(context);
    await this.fence(context);
    await this.projector.deactivate?.(context);
    await this.fence(context);
    await this.daemon(context, 'drain', { drainSeconds });
  }

  async stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    await this.claimAndFence(context);
    await this.fence(context);
    await this.projector.deactivate?.(context);
    const runtime = this.runtime(context);
    const snapshot = deploymentAvailabilitySnapshot(context, runtime, {}, prior.runtimeIdentity);
    await this.fence(context);
    const result = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'stop', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({ deployment: snapshot }),
    });
    if (!result.success && !/not running|already stopped|not found|no such/i.test(result.error ?? '')) {
      throw new AppError(502, 'AVAILABILITY_DEPLOYMENT_STOP_FAILED', result.error || 'Deployment stop failed');
    }
    const runtimeIdentity = {
      ...(prior.runtimeIdentity ?? {}),
      deploymentId: runtime.deploymentId,
      routerName: runtime.routerName,
      networkName: runtime.networkName,
      slots: runtime.slots,
      activeSlot: String(prior.runtimeIdentity?.activeSlot ?? snapshot.activeSlot ?? 'blue'),
    };
    await this.fence(context);
    const stopped = await this.daemon(context, 'stop', { runtimeIdentity });
    return this.stoppedResult(context, stopped, runtimeIdentity, context.resource.imageReference);
  }

  async startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    await this.claimAndFence(context);
    const runtime = this.runtime(context);
    const snapshot = deploymentAvailabilitySnapshot(context, runtime, {}, prior.runtimeIdentity);
    const inspected = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'inspect', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({ deployment: snapshot }),
    });
    const observed = inspected.success ? parseDetail(inspected.detail) : {};
    if (!this.runtimeOwnershipIsValid(context, observed.containers, runtime, snapshot.activeSlot, true, false, true)) {
      throw new AppError(
        409,
        'AVAILABILITY_DEPLOYMENT_NAME_CONFLICT',
        'Existing deployment containers are missing or owned by another workload'
      );
    }
    await this.projector.prepare(context);
    await this.fence(context);
    // The daemon start command inspects and starts existing slot/router IDs only.
    // It also waits for the deployment's configured application health checks.
    const started = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'start', {
      deploymentId: runtime.deploymentId,
      configJson: JSON.stringify({ deployment: snapshot }),
    });
    if (!started.success)
      throw new AppError(502, 'AVAILABILITY_DEPLOYMENT_START_FAILED', started.error || 'Deployment start failed');
    const activeSlot = await this.verifyRuntimeOwnership(context, runtime, snapshot.activeSlot, true, true);
    const runtimeIdentity = { ...prior.runtimeIdentity, ...runtime, ...parseDetail(started.detail), activeSlot };
    await this.fence(context);
    const active = await this.daemon(context, 'activate', { runtimeIdentity });
    return this.activateResult(context, this.result(context, active, runtimeIdentity, context.resource.imageReference));
  }

  async removePlacement(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'removed') {
      await this.fence(context);
      await this.projector.cleanup(context);
      return;
    }
    await this.claimAndFence(context);
    const runtime = this.runtime(context);
    await this.removeRuntime(context, runtime);
    await this.fence(context);
    await this.projector.cleanup(context);
    await this.fence(context);
    await this.daemon(context, 'remove');
  }

  async adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'single') {
      await this.fence(context);
      await this.projector.adopt?.(context);
      return;
    }
    await this.claimAndFence(context);
    const runtime = this.runtime(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const activeSlot = await this.verifyRuntimeOwnership(
      context,
      runtime,
      String(prior.runtimeIdentity?.activeSlot ?? spec.activeSlot ?? 'blue'),
      true
    );
    const [deployment] = await this.db
      .select({ desiredConfig: dockerDeployments.desiredConfig })
      .from(dockerDeployments)
      .where(eq(dockerDeployments.id, context.resource.resourceId))
      .limit(1);
    const sourceImageReference = String(
      context.resource.sourceImageReference ?? spec.sourceImageReference ?? spec.desiredConfig?.image ?? ''
    ).trim();
    const immutableImageReference = String(context.resource.imageReference ?? spec.desiredConfig?.image ?? '').trim();
    if (
      sourceImageReference &&
      immutableImageReference &&
      sourceImageReference !== immutableImageReference &&
      !isDigestPinnedImageReference(sourceImageReference)
    ) {
      const tagged = await this.dispatch.sendDockerImageCommand(context.nodeId, 'tag', {
        imageRef: immutableImageReference,
        targetImageRef: sourceImageReference,
      });
      if (!tagged.success) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_IMAGE_TAG_FAILED',
          tagged.error || 'The surviving deployment image could not be restored to its source tag'
        );
      }
    }
    const dependencies = await this.projector.prepare(context);
    const currentDesiredConfig = (deployment?.desiredConfig ?? {}) as Record<string, any>;
    const adoptedDesiredConfig = {
      ...currentDesiredConfig,
      image: sourceImageReference || immutableImageReference || currentDesiredConfig.image,
      labels: sanitizedLabels(spec.desiredConfig?.labels),
      networks: dependencies.networkNames.length > 0 ? dependencies.networkNames : currentDesiredConfig.networks,
    };
    const rolloutDesiredConfig = {
      ...adoptedDesiredConfig,
      env: { ...(currentDesiredConfig.env ?? {}), ...dependencies.environment },
      extraHosts: Object.entries(dependencies.extraHosts).map(([host, address]) => `${host}:${address}`),
    };
    let adoptedActiveSlot = activeSlot;
    let adoptedRuntimeIdentity: Record<string, any> = { ...(prior.runtimeIdentity ?? {}) };
    if (context.resource.running) {
      const toSlot = activeSlot === 'blue' ? 'green' : 'blue';
      const snapshot = deploymentAvailabilitySnapshot(context, runtime, {}, prior.runtimeIdentity);
      await this.fence(context);
      const deployed = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'deploy_slot', {
        deploymentId: runtime.deploymentId,
        slot: toSlot,
        configJson: JSON.stringify({ deployment: snapshot, toSlot, desiredConfig: rolloutDesiredConfig }),
      });
      if (!deployed.success) {
        throw new AppError(
          409,
          'AVAILABILITY_SINGLE_ADOPTION_ROLLOUT_FAILED',
          deployed.error || 'The surviving deployment could not be normalized for single-node operation',
          { retryable: true }
        );
      }
      const deployedIdentity = parseDetail(deployed.detail);
      await this.fence(context);
      const switched = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'switch', {
        deploymentId: runtime.deploymentId,
        slot: toSlot,
        configJson: JSON.stringify({ deployment: snapshot, activeSlot: toSlot }),
      });
      if (!switched.success) {
        throw new AppError(
          409,
          'AVAILABILITY_SINGLE_ADOPTION_SWITCH_FAILED',
          switched.error || 'The surviving deployment traffic switch failed',
          { retryable: true }
        );
      }
      const switchedIdentity = parseDetail(switched.detail);
      await this.fence(context);
      const stopped = await this.dispatch.sendDockerDeploymentCommand(context.nodeId, 'stop_slot', {
        deploymentId: runtime.deploymentId,
        slot: activeSlot,
        configJson: JSON.stringify({ deployment: snapshot, slot: activeSlot }),
      });
      if (!stopped.success && !/not found|no such|not running|already stopped/i.test(stopped.error ?? '')) {
        throw new AppError(
          409,
          'AVAILABILITY_SINGLE_ADOPTION_STOP_FAILED',
          stopped.error || 'The previous Availability deployment slot could not be stopped',
          { retryable: true }
        );
      }
      adoptedActiveSlot = toSlot;
      adoptedRuntimeIdentity = {
        ...adoptedRuntimeIdentity,
        ...deployedIdentity,
        ...switchedIdentity,
        activeSlot: toSlot,
      };
    }
    const inactiveSlot = adoptedActiveSlot === 'blue' ? 'green' : 'blue';
    const activeContainerId =
      String(
        adoptedRuntimeIdentity[`${adoptedActiveSlot}ContainerId`] ?? adoptedRuntimeIdentity.containerId ?? ''
      ).trim() || null;
    const inactiveContainerId = String(adoptedRuntimeIdentity[`${inactiveSlot}ContainerId`] ?? '').trim() || null;
    await this.fence(context);
    await this.db.transaction(async (tx) => {
      await tx
        .update(dockerDeployments)
        .set({
          nodeId: context.nodeId,
          desiredConfig: adoptedDesiredConfig,
          routerName: runtime.routerName,
          networkName: runtime.networkName,
          activeSlot: adoptedActiveSlot,
          status: context.resource.running ? 'ready' : 'stopped',
          updatedAt: new Date(),
        })
        .where(eq(dockerDeployments.id, context.resource.resourceId));
      await tx
        .update(dockerDeploymentSlots)
        .set({
          containerName: runtime.slots[adoptedActiveSlot],
          containerId: activeContainerId,
          image: adoptedDesiredConfig.image,
          desiredConfig: adoptedDesiredConfig,
          status: context.resource.running ? 'running' : 'stopped',
          health: context.resource.running ? 'healthy' : 'unknown',
          drainingUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dockerDeploymentSlots.deploymentId, context.resource.resourceId),
            eq(dockerDeploymentSlots.slot, adoptedActiveSlot)
          )
        );
      await tx
        .update(dockerDeploymentSlots)
        .set({
          containerName: runtime.slots[inactiveSlot],
          containerId: inactiveContainerId,
          image: adoptedDesiredConfig.image,
          desiredConfig: adoptedDesiredConfig,
          status: 'stopped',
          health: 'unknown',
          drainingUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(dockerDeploymentSlots.deploymentId, context.resource.resourceId),
            eq(dockerDeploymentSlots.slot, inactiveSlot)
          )
        );
    });
    await this.fence(context);
    await this.projector.adopt?.(context);
    await this.fence(context);
    await this.daemon(context, 'adopt_single', { runtimeIdentity: { ...runtime, activeSlot: adoptedActiveSlot } });
  }
}

export class DockerComposeAvailabilityAdapter extends BaseAvailabilityAdapter implements DockerAvailabilityAdapter {
  readonly kind = 'compose' as const;

  constructor(
    db: DrizzleClient,
    dispatch: NodeDispatchService,
    private readonly secrets: DockerSecretService,
    projector?: DockerAvailabilityDependencyProjector
  ) {
    super(db, dispatch, projector);
  }

  async resolve(resource: DockerAvailabilityResource): Promise<DockerAvailabilityResolvedResource> {
    if (resource.type !== 'compose')
      throw new AppError(400, 'AVAILABILITY_RESOURCE_KIND_MISMATCH', 'Compose project expected');
    const [project] = await this.db
      .select()
      .from(dockerComposeProjects)
      .where(eq(dockerComposeProjects.id, resource.composeProjectId))
      .limit(1);
    if (!project) throw new AppError(404, 'COMPOSE_PROJECT_NOT_FOUND', 'Compose project not found');
    if (project.managementState !== 'managed' || !project.activeRevisionId) {
      throw new AppError(409, 'COMPOSE_ACTIVE_REVISION_REQUIRED', 'A managed active Compose revision is required');
    }
    const [revision] = await this.db
      .select()
      .from(dockerComposeRevisions)
      .where(eq(dockerComposeRevisions.id, project.activeRevisionId))
      .limit(1);
    if (!revision) throw new AppError(404, 'COMPOSE_REVISION_NOT_FOUND', 'Compose revision not found');
    const normalizedModel = JSON.parse(JSON.stringify(revision.normalizedModel)) as Record<string, any>;
    const listed = await this.dispatch.sendDockerContainerCommand(project.nodeId, 'list');
    if (!listed.success) {
      throw new AppError(502, 'AVAILABILITY_COMPOSE_INSPECT_FAILED', listed.error || 'Compose inspection failed');
    }
    const containers = parseStrictListDetail(
      listed.detail,
      'AVAILABILITY_COMPOSE_INSPECT_FAILED',
      'Compose inspection returned an invalid container inventory'
    );
    const imageInventoryResult = await this.dispatch.sendDockerImageCommand(project.nodeId, 'list');
    const imageInventory = imageInventoryResult.success
      ? parseStrictListDetail(
          imageInventoryResult.detail,
          'AVAILABILITY_COMPOSE_INSPECT_FAILED',
          'Compose image inventory returned an invalid response'
        )
      : [];
    const canonicalImages: Record<string, string> = {};
    for (const [serviceName, service] of Object.entries(
      (normalizedModel.services ?? {}) as Record<string, Record<string, unknown>>
    )) {
      const configuredImage = String(service.image ?? '');
      const buildReference = configuredImage.match(
        /^127\.0\.0\.1:5443\/(gateway\/builds\/[a-z0-9._/-]+)@(sha256:[0-9a-f]{64})$/
      );
      if (buildReference) {
        const [artifact] = await this.db
          .select({ id: dockerBuildArtifacts.id })
          .from(dockerBuildArtifacts)
          .where(
            and(
              eq(dockerBuildArtifacts.registryRepository, buildReference[1]!),
              eq(dockerBuildArtifacts.digest, buildReference[2]!),
              eq(dockerBuildArtifacts.status, 'ready')
            )
          )
          .limit(1);
        if (!artifact) {
          throw new AppError(
            409,
            'AVAILABILITY_CANONICAL_IMAGE_UNRESOLVED',
            `Compose service ${serviceName} references an unavailable built image artifact`
          );
        }
        // A pinned build is already a canonical, shareable source. Preserve it
        // for artifact delivery instead of replacing it with a local image ID
        // or choosing an unrelated tag attached to the running image.
        canonicalImages[serviceName] = configuredImage;
        service.image = configuredImage;
        continue;
      }
      const running = containers.find((container) => {
        const labels = deploymentRowLabels(container);
        return (
          labels['com.docker.compose.project'] === project.name &&
          labels['com.docker.compose.service'] === serviceName &&
          String(container.state ?? container.State ?? '').toLowerCase() === 'running'
        );
      });
      const runtimeImage = String(running?.imageId ?? running?.ImageID ?? '');
      if (/^sha256:[0-9a-f]{64}$/i.test(configuredImage) || /^127\.0\.0\.1:5443\//i.test(configuredImage)) {
        const canonical = canonicalComposeSourceImage(imageInventory, runtimeImage, configuredImage);
        if (!canonical) {
          throw new AppError(
            409,
            'AVAILABILITY_CANONICAL_IMAGE_UNRESOLVED',
            `Compose service ${serviceName} uses an internal runtime image without a canonical source reference`
          );
        }
        canonicalImages[serviceName] = canonical;
      }
      if (/^sha256:[0-9a-f]{64}$/i.test(runtimeImage)) service.image = runtimeImage;
    }
    const canonicalYaml = rewriteComposeSourceImages(revision.originalYaml, canonicalImages);
    const portableSpec = {
      revisionId: revision.id,
      configDigest: revision.configDigest,
      yaml: removeComposePublishedPortsForAvailability(canonicalYaml),
      normalizedModel,
      variables: revision.variables,
      secretKeys: revision.secretKeys,
    };
    return {
      kind: 'compose',
      reference: resource,
      resourceId: project.id,
      displayName: project.name,
      currentNodeId: project.nodeId,
      viewScope: 'docker:compose:view',
      manageScope: 'docker:compose:manage',
      specFingerprint: fingerprint(portableSpec),
      portableSpec,
      composeRevisionId: revision.id,
      running: project.desiredState === 'running',
    };
  }

  async preflight(
    resource: DockerAvailabilityResolvedResource,
    candidateNodes: DockerAvailabilityCandidateNode[],
    scopes: string[]
  ) {
    const model = (resource.portableSpec.normalizedModel ?? {}) as Record<string, any>;
    const services = Object.values(model.services ?? {}) as Array<Record<string, any>>;
    const blockers = [] as DockerAvailabilityAdapterPreflight['blockers'];
    if (Object.keys(model.volumes ?? {}).length > 0 || services.some((service) => (service.volumes?.length ?? 0) > 0)) {
      blockers.push({
        code: 'AVAILABILITY_MOUNTS_UNSUPPORTED',
        message: 'Compose projects with any volume or mount cannot use Availability',
      });
    }
    if (services.some((service) => typeof service.image !== 'string' || !service.image.trim())) {
      blockers.push({ code: 'AVAILABILITY_IMAGE_REQUIRED', message: 'Every Compose service must declare an image' });
    }
    for (const candidate of candidateNodes) {
      if (!candidate.compatible || candidate.id === resource.currentNodeId) continue;
      const listed = await this.dispatch.sendDockerContainerCommand(candidate.id, 'list');
      if (!listed.success) {
        blockers.push({
          code: 'AVAILABILITY_COMPOSE_COLLISION_CHECK_UNAVAILABLE',
          message: 'The candidate node could not be checked for an existing Compose project with the same name',
          nodeId: candidate.id,
        });
        continue;
      }
      let containers: Array<Record<string, any>> = [];
      try {
        const parsed = JSON.parse(listed.detail || '[]');
        containers = Array.isArray(parsed) ? parsed : [];
      } catch {
        blockers.push({
          code: 'AVAILABILITY_COMPOSE_COLLISION_CHECK_UNAVAILABLE',
          message: 'The candidate node returned an invalid Compose project inventory',
          nodeId: candidate.id,
        });
        continue;
      }
      if (
        containers.some((container) => {
          const labels = (container.labels ?? container.Labels ?? {}) as Record<string, unknown>;
          return (
            labels['com.docker.compose.project'] === resource.displayName &&
            String(labels['wiolett.gateway.compose.project-id'] ?? '') !== resource.resourceId
          );
        })
      ) {
        blockers.push({
          code: 'AVAILABILITY_COMPOSE_NAME_CONFLICT',
          message: 'A Compose project with the same runtime name already exists on the candidate node',
          nodeId: candidate.id,
        });
      }
    }
    return this.combinedPreflight(resource, candidateNodes, blockers, scopes);
  }

  private async listRuntimeContainers(
    context: DockerAvailabilityAdapterContext,
    projectName: string
  ): Promise<Array<Record<string, any>>> {
    const listed = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'list');
    if (!listed.success) {
      throw new AppError(502, 'AVAILABILITY_COMPOSE_INSPECT_FAILED', listed.error || 'Compose inspection failed');
    }
    return parseStrictListDetail(
      listed.detail,
      'AVAILABILITY_COMPOSE_INSPECT_FAILED',
      'Compose inspection returned an invalid container inventory'
    ).filter((row) => deploymentRowLabels(row)['com.docker.compose.project'] === projectName);
  }

  private async runtimeIdentity(context: DockerAvailabilityAdapterContext, projectName: string) {
    const rows = await this.listRuntimeContainers(context, projectName);
    return {
      projectId: context.resource.resourceId,
      projectName,
      containers: rows.flatMap((row) => {
        const labels = deploymentRowLabels(row);
        const rawNames = row.names ?? row.Names;
        const containerName = String(
          row.name ?? row.Name ?? (Array.isArray(rawNames) ? rawNames[0] : rawNames) ?? ''
        ).replace(/^\//, '');
        const containerId = String(row.id ?? row.Id ?? row.ID ?? '');
        const serviceName = String(labels['com.docker.compose.service'] ?? '');
        if (!containerId && !containerName) return [];
        return [
          {
            containerId,
            containerName,
            serviceName,
            image: String(row.image ?? row.Image ?? ''),
          },
        ];
      }),
    };
  }

  private composeRuntimeHasForeignCollision(
    rows: Array<Record<string, any>>,
    context: DockerAvailabilityAdapterContext
  ): boolean {
    return rows.some(
      (row) => deploymentRowLabels(row)['wiolett.gateway.compose.project-id'] !== context.resource.resourceId
    );
  }

  private composeRuntimeOwnershipIsValid(
    rows: Array<Record<string, any>>,
    context: DockerAvailabilityAdapterContext,
    allowRevisionMismatch = false
  ): boolean {
    if (rows.length === 0) return false;
    const spec = context.resource.portableSpec as Record<string, any>;
    const expectedRevision = String(spec.configDigest ?? '');
    const services = (spec.normalizedModel?.services ?? {}) as Record<string, Record<string, any>>;
    for (const row of rows) {
      const labels = deploymentRowLabels(row);
      if (
        labels['wiolett.gateway.compose.project-id'] !== context.resource.resourceId ||
        (!allowRevisionMismatch && labels['wiolett.gateway.compose.revision'] !== expectedRevision) ||
        labels['wiolett.gateway.compose.managed'] !== 'true'
      ) {
        return false;
      }
    }
    return Object.entries(services).every(([serviceName, service]) => {
      const row = rows.find(
        (candidate) => deploymentRowLabels(candidate)['com.docker.compose.service'] === serviceName
      );
      return row !== undefined && immutableRuntimeRowImageMatches(row, service.image);
    });
  }

  private composeRuntimeIsSafelyRemovable(
    rows: Array<Record<string, any>>,
    context: DockerAvailabilityAdapterContext
  ): boolean {
    if (rows.length === 0) return false;
    return rows.every((row) => {
      const labels = deploymentRowLabels(row);
      return (
        labels['wiolett.gateway.compose.project-id'] === context.resource.resourceId &&
        labels['wiolett.gateway.compose.managed'] === 'true' &&
        immutableRuntimeRowHasImageId(row)
      );
    });
  }

  async ensurePlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    await this.claimAndFence(context);
    await context.reportProgress?.('preparing_dependencies', 'Preparing Compose database links and networks');
    const dependencies = await this.projector.prepare(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const projectName = composeRuntimeProjectName(context);
    const existing = await this.listRuntimeContainers(context, projectName);
    if (this.composeRuntimeHasForeignCollision(existing, context)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_NAME_CONFLICT',
        'The deterministic Compose project name is already owned by another workload'
      );
    }
    if (this.composeRuntimeOwnershipIsValid(existing, context)) {
      await this.waitUntilReady(context);
      const runtimeIdentity = await this.runtimeIdentity(context, projectName);
      await this.fence(context);
      const active = await this.daemon(context, 'activate', { runtimeIdentity });
      return this.activateResult(
        context,
        this.result(context, active, runtimeIdentity, undefined, context.resource.composeRevisionId)
      );
    }
    const secrets = await this.secrets.getDecryptedMap(
      context.resource.currentNodeId,
      `compose:${context.resource.resourceId}`
    );
    await this.fence(context);
    await context.reportProgress?.('starting', 'Pulling images and applying the replacement Compose revision');
    const result = await this.dispatch.sendDockerComposeCommand(context.nodeId, 'pull_apply', {
      operationId: availabilityComposeOperationId(context, 'pull_apply'),
      projectId: context.resource.resourceId,
      projectName,
      revisionId: String(spec.revisionId ?? ''),
      configDigest: String(spec.configDigest ?? ''),
      composeYaml: Buffer.from(dependencies.composeYaml ?? String(spec.yaml ?? ''), 'utf8'),
      normalizedModelJson: JSON.stringify(spec.normalizedModel ?? {}),
      variables: (spec.variables ?? {}) as Record<string, string>,
      secrets: { ...secrets, ...(dependencies.composeSecrets ?? {}) },
      removeOrphans: true,
      volumeNames: [],
    });
    if (!result.success)
      throw new AppError(502, 'AVAILABILITY_COMPOSE_APPLY_FAILED', result.error || 'Compose placement failed');
    await context.reportProgress?.('checking_health', 'Waiting for every Compose service to become healthy');
    await this.waitUntilReady(context);
    const runtimeIdentity = await this.runtimeIdentity(context, projectName);
    await this.fence(context);
    const active = await this.daemon(context, 'activate', { runtimeIdentity });
    return this.activateResult(
      context,
      this.result(context, active, runtimeIdentity, undefined, context.resource.composeRevisionId)
    );
  }

  private async waitUntilReady(
    context: DockerAvailabilityAdapterContext,
    existingContainerIds?: string[]
  ): Promise<void> {
    const services = Object.keys(
      ((context.resource.portableSpec.normalizedModel as Record<string, any> | undefined)?.services ?? {}) as Record<
        string,
        unknown
      >
    );
    const deadline = Date.now() + 60_000;
    const stableSince = new Map<string, number>();
    const restartCounts = new Map<string, number>();
    let ready = 0;
    while (Date.now() < deadline) {
      const containers = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'list');
      if (!containers.success) {
        throw new AppError(
          502,
          'AVAILABILITY_COMPOSE_INSPECT_FAILED',
          containers.error || 'Compose readiness inspection failed'
        );
      }
      const rows = parseStrictListDetail(
        containers.detail,
        'AVAILABILITY_COMPOSE_INSPECT_FAILED',
        'Compose readiness inspection returned an invalid container inventory'
      );
      const placement = rows.filter((row) => {
        const labels = deploymentRowLabels(row);
        return labels['com.docker.compose.project'] === composeRuntimeProjectName(context);
      });
      if (this.composeRuntimeHasForeignCollision(placement, context)) {
        throw new AppError(
          409,
          'AVAILABILITY_COMPOSE_NAME_CONFLICT',
          'The Compose placement is owned by another workload'
        );
      }
      const healthyServices = new Set<string>();
      for (const row of placement) {
        const serviceName = String((row.Labels ?? row.labels)?.['com.docker.compose.service'] ?? '');
        const containerId = String(row.id ?? row.ID ?? row.name ?? row.Name ?? '');
        if (!serviceName || !containerId) continue;
        const inspected = await this.dispatch.sendDockerContainerCommand(context.nodeId, 'inspect', { containerId });
        if (!inspected.success) {
          throw new AppError(
            502,
            'AVAILABILITY_COMPOSE_INSPECT_FAILED',
            inspected.error || 'Compose service inspection failed'
          );
        }
        const detail = parseStrictDetail(
          inspected.detail,
          'AVAILABILITY_COMPOSE_INSPECT_FAILED',
          'Compose service inspection returned an invalid response'
        );
        const state = (detail.State ?? detail.state ?? {}) as Record<string, any>;
        const running = state.Running === true || String(state.Status ?? '').toLowerCase() === 'running';
        const health = String(state.Health?.Status ?? '').toLowerCase();
        if (running && health === 'healthy') {
          healthyServices.add(serviceName);
          continue;
        }
        if (running && !health && state.Restarting !== true) {
          const restartCount = Number(detail.RestartCount ?? detail.restartCount ?? 0);
          if (!stableSince.has(containerId) || restartCounts.get(containerId) !== restartCount) {
            stableSince.set(containerId, Date.now());
            restartCounts.set(containerId, restartCount);
          } else if (Date.now() - stableSince.get(containerId)! >= 10_000) {
            healthyServices.add(serviceName);
          }
        } else {
          stableSince.delete(containerId);
          restartCounts.delete(containerId);
        }
      }
      ready = services.filter((service) => healthyServices.has(service)).length;
      if (services.length > 0 && ready === services.length) {
        const identityValid = existingContainerIds
          ? this.composeRuntimeIsSafelyRemovable(placement, context) &&
            placement.length === existingContainerIds.length &&
            placement.every((row) => existingContainerIds.includes(String(row.id ?? row.Id ?? row.ID ?? '')))
          : this.composeRuntimeOwnershipIsValid(placement, context);
        if (!identityValid) {
          throw new AppError(
            409,
            'AVAILABILITY_COMPOSE_IDENTITY_CONFLICT',
            'The ready Compose project does not match the claimed revision or immutable service images'
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AppError(
      409,
      'AVAILABILITY_COMPOSE_UNHEALTHY',
      `Compose placement did not become ready (${ready}/${services.length} services)`,
      { retryable: true }
    );
  }

  async drainPlacement(context: DockerAvailabilityAdapterContext, drainSeconds: number): Promise<void> {
    await this.claimAndFence(context);
    await this.fence(context);
    await this.projector.deactivate?.(context);
    await this.fence(context);
    await this.daemon(context, 'drain', { drainSeconds });
  }

  async stopPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    return this.setPlacementRunning(context, false);
  }

  async startPlacement(context: DockerAvailabilityAdapterContext): Promise<DockerAvailabilityPlacementResult> {
    return this.setPlacementRunning(context, true);
  }

  private async setPlacementRunning(
    context: DockerAvailabilityAdapterContext,
    running: boolean
  ): Promise<DockerAvailabilityPlacementResult> {
    const prior = await this.inspectOptional(context);
    await this.claimAndFence(context);
    await this.fence(context);
    if (!running) await this.projector.deactivate?.(context);
    const projectName = composeRuntimeProjectName(context);
    const existing = running ? await this.listRuntimeContainers(context, projectName) : [];
    if (running && !this.composeRuntimeIsSafelyRemovable(existing, context)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_NAME_CONFLICT',
        'Existing Compose containers are missing or owned by another workload'
      );
    }
    const dependencies = await this.projector.prepare(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const secrets = await this.secrets.getDecryptedMap(
      context.resource.currentNodeId,
      `compose:${context.resource.resourceId}`
    );
    await this.fence(context);
    const action = running ? 'start' : 'stop';
    const result = await this.dispatch.sendDockerComposeCommand(context.nodeId, action, {
      operationId: availabilityComposeOperationId(context, action),
      projectId: context.resource.resourceId,
      projectName,
      revisionId: String(spec.revisionId ?? ''),
      configDigest: String(spec.configDigest ?? ''),
      composeYaml: Buffer.from(dependencies.composeYaml ?? String(spec.yaml ?? ''), 'utf8'),
      normalizedModelJson: JSON.stringify(spec.normalizedModel ?? {}),
      variables: (spec.variables ?? {}) as Record<string, string>,
      secrets: { ...secrets, ...(dependencies.composeSecrets ?? {}) },
      removeOrphans: false,
      volumeNames: [],
    });
    if (!result.success && (running || !/not running|already stopped|not found|no such/i.test(result.error ?? ''))) {
      throw new AppError(
        502,
        running ? 'AVAILABILITY_COMPOSE_START_FAILED' : 'AVAILABILITY_COMPOSE_STOP_FAILED',
        result.error || `Compose ${action} failed`
      );
    }
    if (running) {
      await context.reportProgress?.('checking_health', 'Waiting for existing Compose services to become healthy');
      await this.waitUntilReady(
        context,
        existing.map((row) => String(row.id ?? row.Id ?? row.ID ?? ''))
      );
      const runtimeIdentity = await this.runtimeIdentity(context, projectName);
      await this.fence(context);
      const active = await this.daemon(context, 'activate', { runtimeIdentity });
      return this.activateResult(
        context,
        this.result(context, active, runtimeIdentity, undefined, context.resource.composeRevisionId)
      );
    }
    const runtimeIdentity = {
      ...(prior.runtimeIdentity ?? {}),
      projectId: context.resource.resourceId,
      projectName,
    };
    await this.fence(context);
    const stopped = await this.daemon(context, 'stop', { runtimeIdentity });
    return this.stoppedResult(context, stopped, runtimeIdentity, undefined, context.resource.composeRevisionId);
  }

  async removePlacement(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'removed') {
      await this.fence(context);
      await this.projector.cleanup(context);
      return;
    }
    await this.claimAndFence(context);
    const projectName = composeRuntimeProjectName(context);
    const existing = await this.listRuntimeContainers(context, projectName);
    if (this.composeRuntimeHasForeignCollision(existing, context)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_NAME_CONFLICT',
        'The Compose project to remove is owned by another workload'
      );
    }
    if (existing.length > 0 && !this.composeRuntimeIsSafelyRemovable(existing, context)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_IDENTITY_CONFLICT',
        'The Compose project to remove does not have a safely removable managed identity'
      );
    }
    const dependencies = await this.projector.prepare(context);
    const spec = context.resource.portableSpec as Record<string, any>;
    const secrets = await this.secrets.getDecryptedMap(
      context.resource.currentNodeId,
      `compose:${context.resource.resourceId}`
    );
    await this.fence(context);
    const removed = await this.dispatch.sendDockerComposeCommand(context.nodeId, 'down', {
      operationId: availabilityComposeOperationId(context, 'remove'),
      projectId: context.resource.resourceId,
      projectName,
      revisionId: String(spec.revisionId ?? ''),
      configDigest: String(spec.configDigest ?? ''),
      composeYaml: Buffer.from(dependencies.composeYaml ?? String(spec.yaml ?? ''), 'utf8'),
      normalizedModelJson: JSON.stringify(spec.normalizedModel ?? {}),
      variables: (spec.variables ?? {}) as Record<string, string>,
      secrets: { ...secrets, ...(dependencies.composeSecrets ?? {}) },
      removeOrphans: true,
      volumeNames: [],
    });
    if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
      throw new AppError(503, 'AVAILABILITY_COMPOSE_CLEANUP_PENDING', removed.error || 'Compose removal failed', {
        retryable: true,
      });
    }
    await this.fence(context);
    await this.projector.cleanup(context);
    for (const networkName of composeOwnedNetworkNames(projectName, spec)) {
      const networkRemoved = await this.dispatch.sendDockerNetworkCommand(context.nodeId, 'remove', {
        networkId: networkName,
      });
      if (!networkRemoved.success && !/not found|no such/i.test(networkRemoved.error ?? '')) {
        throw new AppError(
          503,
          'AVAILABILITY_COMPOSE_CLEANUP_PENDING',
          networkRemoved.error || `Compose network ${networkName} cleanup is pending`,
          { retryable: true }
        );
      }
    }
    await this.fence(context);
    await this.daemon(context, 'remove');
  }

  async adoptPlacementAsSingle(context: DockerAvailabilityAdapterContext): Promise<void> {
    const prior = await this.inspectOptional(context);
    if (Number(prior.generation ?? 0) === context.generation && prior.state === 'single') {
      await this.fence(context);
      await this.projector.adopt?.(context);
      return;
    }
    await this.claimAndFence(context);
    const projectName = composeRuntimeProjectName(context);
    const existing = await this.listRuntimeContainers(context, projectName);
    if (this.composeRuntimeHasForeignCollision(existing, context)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_NAME_CONFLICT',
        'The surviving Compose project is owned by another workload'
      );
    }
    if (!this.composeRuntimeOwnershipIsValid(existing, context, true)) {
      throw new AppError(
        409,
        'AVAILABILITY_COMPOSE_IDENTITY_UNVERIFIED',
        'The surviving Compose project does not match the claimed revision or immutable service images'
      );
    }
    const spec = context.resource.portableSpec as Record<string, any>;
    const sourceImages = composeSourceImages(String(spec.yaml ?? ''));
    for (const [serviceName, sourceImage] of Object.entries(sourceImages)) {
      if (isDigestPinnedImageReference(sourceImage) || /^127\.0\.0\.1:5443\//i.test(sourceImage)) continue;
      const row = existing.find(
        (candidate) => deploymentRowLabels(candidate)['com.docker.compose.service'] === serviceName
      );
      const runtimeImage = String(row?.image ?? row?.Image ?? row?.imageId ?? row?.ImageID ?? '').trim();
      if (!runtimeImage || runtimeImage === sourceImage) continue;
      const tagged = await this.dispatch.sendDockerImageCommand(context.nodeId, 'tag', {
        imageRef: runtimeImage,
        targetImageRef: sourceImage,
      });
      if (!tagged.success) {
        throw new AppError(
          502,
          'AVAILABILITY_SINGLE_ADOPTION_IMAGE_TAG_FAILED',
          tagged.error || `Compose service ${serviceName} image could not be restored to its source tag`
        );
      }
    }
    const dependencies = await this.projector.prepare(context);
    const secrets = await this.secrets.getDecryptedMap(
      context.resource.currentNodeId,
      `compose:${context.resource.resourceId}`
    );
    const adoptedContext = {
      ...context,
      resource: { ...context.resource, currentNodeId: context.nodeId },
    };
    const ordinary =
      projectName === context.resource.displayName
        ? existing
        : await this.listRuntimeContainers(adoptedContext, context.resource.displayName);
    if (projectName !== context.resource.displayName) {
      if (this.composeRuntimeHasForeignCollision(ordinary, context)) {
        throw new AppError(
          409,
          'AVAILABILITY_COMPOSE_NAME_CONFLICT',
          'The ordinary Compose project name is owned by another workload on the surviving node'
        );
      }
    }
    // The ordinary project becomes the canonical single-node runtime again.
    // This is also required when the origin node survives: Availability uses
    // the ordinary project name there, but its containers still carry the
    // generation-specific artifact revision until the canonical spec is
    // explicitly re-applied.
    if (!this.composeRuntimeOwnershipIsValid(ordinary, adoptedContext)) {
      await this.fence(context);
      const applied = await this.dispatch.sendDockerComposeCommand(context.nodeId, 'apply', {
        operationId: availabilityComposeOperationId(context, 'adopt_single_apply'),
        projectId: context.resource.resourceId,
        projectName: context.resource.displayName,
        revisionId: String(spec.revisionId ?? ''),
        configDigest: String(spec.configDigest ?? ''),
        composeYaml: Buffer.from(dependencies.composeYaml ?? String(spec.yaml ?? ''), 'utf8'),
        normalizedModelJson: JSON.stringify(spec.normalizedModel ?? {}),
        variables: (spec.variables ?? {}) as Record<string, string>,
        secrets: { ...secrets, ...(dependencies.composeSecrets ?? {}) },
        removeOrphans: true,
        volumeNames: [],
      });
      if (!applied.success) {
        throw new AppError(
          502,
          'AVAILABILITY_COMPOSE_ADOPTION_APPLY_FAILED',
          applied.error || 'The surviving Compose project could not be restored under its ordinary name',
          { retryable: true }
        );
      }
    }
    await this.waitUntilReady(adoptedContext);
    await this.db
      .update(dockerComposeProjects)
      .set({ nodeId: context.nodeId, updatedAt: new Date() })
      .where(eq(dockerComposeProjects.id, context.resource.resourceId));
    await this.fence(context);
    await this.projector.prepareFinalAdoption?.(context);
    await this.fence(context);
    await this.projector.adopt?.(context);
    await this.fence(context);
    await this.daemon(context, 'adopt_single', {
      runtimeIdentity: { projectId: context.resource.resourceId, projectName: context.resource.displayName },
    });
    if (projectName !== context.resource.displayName) {
      await this.fence(context);
      const removed = await this.dispatch.sendDockerComposeCommand(context.nodeId, 'down', {
        operationId: availabilityComposeOperationId(context, 'adopt_single_cleanup'),
        projectId: context.resource.resourceId,
        projectName,
        revisionId: String(spec.revisionId ?? ''),
        configDigest: String(spec.configDigest ?? ''),
        composeYaml: Buffer.from(dependencies.composeYaml ?? String(spec.yaml ?? ''), 'utf8'),
        normalizedModelJson: JSON.stringify(spec.normalizedModel ?? {}),
        variables: (spec.variables ?? {}) as Record<string, string>,
        secrets: { ...secrets, ...(dependencies.composeSecrets ?? {}) },
        removeOrphans: true,
        volumeNames: [],
      });
      if (!removed.success && !/not found|no such/i.test(removed.error ?? '')) {
        throw new AppError(
          503,
          'AVAILABILITY_COMPOSE_ADOPTION_CLEANUP_PENDING',
          removed.error || 'The Availability Compose project cleanup is pending',
          { retryable: true }
        );
      }
    }
  }
}
