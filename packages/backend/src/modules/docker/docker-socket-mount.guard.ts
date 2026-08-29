import path from 'node:path';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';

type DockerMountInput = {
  hostPath?: string | null;
  containerPath?: string | null;
  name?: string | null;
  readOnly?: boolean | null;
};

type DockerInspectMount = {
  Type?: string;
  Source?: string;
  Destination?: string;
  Name?: string;
  RW?: boolean;
};

type DockerInspectData = {
  HostConfig?: { Binds?: string[] | null } | null;
  Mounts?: DockerInspectMount[] | null;
};

export type NormalizedMountDefinition = {
  type: 'bind' | 'volume';
  source: string;
  target: string;
  readOnly: boolean;
  options?: readonly string[];
};

function normalizeHostPath(input: string | null | undefined): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  return path.posix.normalize(trimmed.replaceAll('\\', '/'));
}

function normalizeContainerPath(input: string | null | undefined): string {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  return path.posix.normalize(trimmed.replaceAll('\\', '/'));
}

function normalizeMountInput(mount: DockerMountInput): NormalizedMountDefinition | null {
  const target = normalizeContainerPath(mount.containerPath);
  if (!target) return null;
  const hostPath = normalizeHostPath(mount.hostPath);
  if (hostPath) {
    return { type: 'bind', source: hostPath, target, readOnly: mount.readOnly === true };
  }
  const name = String(mount.name ?? '').trim();
  if (!name) return null;
  return { type: 'volume', source: name, target, readOnly: mount.readOnly === true };
}

function parseBindOptions(modeParts: string[]): { readOnly: boolean; options: string[] } {
  const tokens = modeParts
    .flatMap((part) => part.split(','))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return {
    readOnly: tokens.includes('ro'),
    options: tokens.filter((token) => token !== 'ro' && token !== 'rw').sort(),
  };
}

function parseBindDefinition(bind: string): NormalizedMountDefinition | null {
  const [rawSource, rawTarget, ...modeParts] = bind.split(':');
  const target = normalizeContainerPath(rawTarget);
  if (!rawSource || !target) return null;
  const source = rawSource.trim();
  if (!source) return null;
  const { readOnly, options } = parseBindOptions(modeParts);
  if (source.startsWith('/')) {
    return { type: 'bind', source: normalizeHostPath(source), target, readOnly, options };
  }
  return { type: 'volume', source, target, readOnly, options };
}

export function normalizeMountDefinitionsFromConfig(config: {
  mounts?: DockerMountInput[] | null;
  volumes?: DockerMountInput[] | null;
}): NormalizedMountDefinition[] {
  const definitions: NormalizedMountDefinition[] = [];
  for (const mount of config.mounts ?? []) {
    const normalized = normalizeMountInput(mount);
    if (normalized) definitions.push(normalized);
  }
  for (const mount of config.volumes ?? []) {
    const normalized = normalizeMountInput(mount);
    if (normalized) definitions.push(normalized);
  }
  return sortMountDefinitions(definitions);
}

export function normalizeMountDefinitionsFromInspect(
  inspect: DockerInspectData | null | undefined
): NormalizedMountDefinition[] {
  const definitions: NormalizedMountDefinition[] = [];
  const bindTargets = new Set<string>();
  for (const bind of inspect?.HostConfig?.Binds ?? []) {
    const normalized = parseBindDefinition(bind);
    if (normalized) {
      definitions.push(normalized);
      bindTargets.add(definitionIdentity(normalized));
    }
  }
  for (const mount of inspect?.Mounts ?? []) {
    const target = normalizeContainerPath(mount.Destination);
    if (!target) continue;
    const type = String(mount.Type ?? '').toLowerCase();
    if (type === 'bind') {
      const source = normalizeHostPath(mount.Source);
      if (source) {
        const definition = { type: 'bind' as const, source, target, readOnly: mount.RW === false };
        if (!bindTargets.has(definitionIdentity(definition))) definitions.push(definition);
      }
      continue;
    }
    if (type === 'volume') {
      const source = String(mount.Name ?? mount.Source ?? '').trim();
      if (source) {
        const definition = { type: 'volume' as const, source, target, readOnly: mount.RW === false };
        if (!bindTargets.has(definitionIdentity(definition))) definitions.push(definition);
      }
    }
  }
  return sortMountDefinitions(dedupeMountDefinitions(definitions));
}

function sortMountDefinitions(definitions: NormalizedMountDefinition[]): NormalizedMountDefinition[] {
  return [...definitions].sort((a, b) => serializeMount(a).localeCompare(serializeMount(b)));
}

function dedupeMountDefinitions(definitions: NormalizedMountDefinition[]): NormalizedMountDefinition[] {
  return [...new Map(definitions.map((definition) => [serializeMount(definition), definition])).values()];
}

function serializeMount(definition: NormalizedMountDefinition): string {
  const options = [...(definition.options ?? [])].sort().join(',');
  return `${definition.type}:${definition.source}:${definition.target}:${definition.readOnly ? 'ro' : 'rw'}:${options}`;
}

function definitionIdentity(definition: NormalizedMountDefinition): string {
  return `${definition.type}:${definition.source}:${definition.target}:${definition.readOnly ? 'ro' : 'rw'}`;
}

function definitionsEqual(current: NormalizedMountDefinition[], next: NormalizedMountDefinition[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((definition, index) => serializeMount(definition) === serializeMount(next[index]));
}

function hasConfigMountFields(config: { mounts?: unknown; volumes?: unknown } | undefined) {
  return !!config && (Object.hasOwn(config, 'mounts') || Object.hasOwn(config, 'volumes'));
}

export function assertDockerMountChangeAllowed(args: {
  nodeId: string;
  resourceId?: string;
  actorScopes: readonly string[];
  nextConfig?: { mounts?: DockerMountInput[] | null; volumes?: DockerMountInput[] | null };
  nextDefinitions?: NormalizedMountDefinition[];
  currentInspect?: DockerInspectData | null;
  currentDefinitions?: NormalizedMountDefinition[];
  useCurrentWhenNextMissing?: boolean;
}): { mountsChanged: boolean } {
  const currentDefinitions = args.currentDefinitions ?? normalizeMountDefinitionsFromInspect(args.currentInspect);
  const nextDefinitions = args.nextDefinitions
    ? sortMountDefinitions(args.nextDefinitions)
    : args.useCurrentWhenNextMissing && !hasConfigMountFields(args.nextConfig)
      ? currentDefinitions
      : normalizeMountDefinitionsFromConfig(args.nextConfig ?? {});
  const mountsChanged = !definitionsEqual(currentDefinitions, nextDefinitions);

  const resourceSuffix = args.resourceId ? `${args.nodeId}/${args.resourceId}` : args.nodeId;
  const hasMountScope = hasScope([...args.actorScopes], `docker:containers:mounts:${resourceSuffix}`);
  const preservesHostBindCapability = currentDefinitions.some((definition) => definition.type === 'bind');
  if ((mountsChanged || preservesHostBindCapability) && !hasMountScope) {
    throw new AppError(
      403,
      'MISSING_DOCKER_MOUNTS_SCOPE',
      preservesHostBindCapability && !mountsChanged
        ? 'Mutating a Docker container or deployment with host bind mounts requires docker:containers:mounts'
        : 'Changing Docker container or deployment mounts requires docker:containers:mounts for this node'
    );
  }

  return { mountsChanged };
}
