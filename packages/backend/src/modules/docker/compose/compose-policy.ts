import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';
import type {
  DockerComposeNormalizedModel,
  DockerComposeNormalizedResource,
  DockerComposeNormalizedService,
  DockerComposeNormalizedVolume,
} from '@/db/schema/index.js';
import { COMPOSE_YAML_MAX_BYTES, type ComposeYamlInput } from './compose.schemas.js';
import type {
  ComposeGitBuildPreparation,
  ComposeGitBuildSpec,
  ComposeValidationDiagnostic,
  ComposeValidationResult,
} from './compose-policy.types.js';

export type {
  ComposeGitBuildPreparation,
  ComposeGitBuildSpec,
  ComposeValidationDiagnostic,
  ComposeValidationResult,
} from './compose-policy.types.js';

const TOP_LEVEL_KEYS = new Set(['name', 'version', 'services', 'volumes', 'networks']);
const SERVICE_KEYS = new Set([
  'image',
  'cpus',
  'cpu_shares',
  'mem_limit',
  'mem_reservation',
  'memswap_limit',
  'pids_limit',
  'environment',
  'command',
  'entrypoint',
  'working_dir',
  'user',
  'hostname',
  'extra_hosts',
  'ports',
  'healthcheck',
  'depends_on',
  'restart',
  'volumes',
  'networks',
  'labels',
]);
const EXPLICITLY_REJECTED_SERVICE_KEYS = new Map<string, string>([
  ['build', 'Compose build is not supported; every service must use a pre-built image'],
  ['env_file', 'env_file is not supported; define environment bindings explicitly'],
  ['profiles', 'Compose profiles are not supported'],
  ['develop', 'Compose develop/watch is not supported'],
  ['deploy', 'Compose deploy, replicas, and scale are not supported'],
  ['extends', 'Compose extends is not supported'],
  ['configs', 'File-backed Compose configs are not supported'],
  ['secrets', 'File-backed Compose secrets are not supported; use Gateway secret bindings'],
  ['privileged', 'Privileged containers are not supported'],
  ['devices', 'Host devices are not supported'],
  ['network_mode', 'Host or service network modes are not supported'],
  ['pid', 'Host or service PID modes are not supported'],
  ['ipc', 'Host or service IPC modes are not supported'],
]);
const RESERVED_LABEL_PREFIXES = ['com.docker.compose.', 'wiolett.gateway.compose.'];
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g;
const BYTE_VALUE_PATTERN = /^\d+(?:\.\d+)?(?:[kmgtpe]i?b?|b)?$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  );
}

function relativeBuildPath(value: unknown, fallback: string): string | null {
  const raw = value === undefined ? fallback : typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..') || raw.includes('\0')) return null;
  const normalized = posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function prepareComposeGitBuild(
  input: ComposeYamlInput,
  images: Record<string, string> = {}
): ComposeGitBuildPreparation {
  const diagnostics: ComposeValidationDiagnostic[] = [];
  const documents = parseAllDocuments(input.yaml, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    customTags: [],
    logLevel: 'silent',
  });
  const document = documents.length === 1 ? documents[0] : null;
  for (const error of document?.errors ?? []) diagnostic(diagnostics, 'YAML_PARSE_ERROR', error.message);
  let parsed: unknown = null;
  try {
    parsed = document?.toJS({ maxAliasCount: 0, mapAsMap: false }) ?? null;
  } catch (error) {
    diagnostic(diagnostics, 'YAML_CONVERSION_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed) || !isRecord(parsed.services)) {
    diagnostic(diagnostics, 'SERVICES_REQUIRED', 'At least one service is required', 'services');
  }

  const services: ComposeGitBuildSpec[] = [];
  if (isRecord(parsed) && isRecord(parsed.services)) {
    for (const [serviceName, value] of Object.entries(parsed.services)) {
      if (!isRecord(value)) continue;
      if (!('build' in value)) continue;
      const build = value.build;
      let contextPath: string | null;
      let dockerfilePath: string | null;
      let buildArgs: Record<string, string> = {};
      if (typeof build === 'string') {
        contextPath = relativeBuildPath(build, '.');
        dockerfilePath = contextPath ? posix.join(contextPath, 'Dockerfile') : null;
      } else if (isRecord(build)) {
        for (const key of Object.keys(build)) {
          if (!['context', 'dockerfile', 'args'].includes(key)) {
            diagnostic(
              diagnostics,
              'UNSUPPORTED_BUILD_FIELD',
              `Unsupported Compose build field: ${key}`,
              `services.${serviceName}.build.${key}`
            );
          }
        }
        contextPath = relativeBuildPath(build.context, '.');
        const dockerfileRelativePath = relativeBuildPath(build.dockerfile, 'Dockerfile');
        dockerfilePath = contextPath && dockerfileRelativePath ? posix.join(contextPath, dockerfileRelativePath) : null;
        if (build.args !== undefined) {
          if (!isRecord(build.args)) {
            diagnostic(
              diagnostics,
              'INVALID_BUILD_ARGS',
              'Compose build args must be a mapping',
              `services.${serviceName}.build.args`
            );
          } else {
            buildArgs = Object.fromEntries(
              Object.entries(build.args).map(([key, argument]) => [key, argument == null ? '' : String(argument)])
            );
          }
        }
      } else {
        contextPath = null;
        dockerfilePath = null;
      }
      if (!contextPath)
        diagnostic(
          diagnostics,
          'INVALID_BUILD_CONTEXT',
          'Compose build context must stay inside the repository',
          `services.${serviceName}.build.context`
        );
      if (!dockerfilePath)
        diagnostic(
          diagnostics,
          'INVALID_DOCKERFILE_PATH',
          'Compose Dockerfile path must stay inside the repository',
          `services.${serviceName}.build.dockerfile`
        );
      if (!contextPath || !dockerfilePath) continue;
      services.push({ serviceName, contextPath, dockerfilePath, buildArgs });
      value.image = images[serviceName] ?? `gateway.invalid/compose-build/${serviceName}:pending`;
      delete value.build;
    }
  }
  if (services.length === 0) diagnostic(diagnostics, 'COMPOSE_BUILD_REQUIRED', 'No Compose services define build');
  const runtimeYaml = isRecord(parsed) ? stringify(parsed, { lineWidth: 0 }) : null;
  const validation = runtimeYaml
    ? validateComposeYaml({ ...input, yaml: runtimeYaml })
    : {
        valid: false,
        projectName: input.projectName,
        normalizedModel: null,
        configDigest: null,
        requiredVariables: [],
        diagnostics: [],
      };
  diagnostics.push(...validation.diagnostics);
  return {
    valid: diagnostics.every((item) => item.severity !== 'error'),
    runtimeYaml,
    services,
    validation,
    diagnostics,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function diagnostic(
  diagnostics: ComposeValidationDiagnostic[],
  code: string,
  message: string,
  path?: string,
  severity: 'error' | 'warning' = 'error'
) {
  diagnostics.push({ severity, code, message, ...(path ? { path } : {}) });
}

function scalarString(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  diagnostic(diagnostics, 'INVALID_VALUE', 'Expected a scalar value', path);
  return null;
}

function nonNegativeNumber(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): number | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(normalized) || normalized < 0) {
    diagnostic(diagnostics, 'INVALID_RESOURCE_LIMIT', 'Expected a non-negative number', path);
    return undefined;
  }
  return normalized;
}

function nonNegativeInteger(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): number | undefined {
  const normalized = nonNegativeNumber(value, path, diagnostics);
  if (normalized === undefined) return undefined;
  if (!Number.isInteger(normalized)) {
    diagnostic(diagnostics, 'INVALID_RESOURCE_LIMIT', 'Expected a non-negative integer', path);
    return undefined;
  }
  return normalized;
}

function pidsLimit(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]): number | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(normalized) || normalized === 0 || normalized < -1) {
    diagnostic(diagnostics, 'INVALID_RESOURCE_LIMIT', 'Expected -1 or a positive integer', path);
    return undefined;
  }
  return normalized;
}

function byteValue(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[],
  allowUnlimited = false
): string | undefined {
  if (value === undefined) return undefined;
  if (allowUnlimited && String(value).trim() === '-1') return '-1';
  if ((typeof value !== 'string' && typeof value !== 'number') || !BYTE_VALUE_PATTERN.test(String(value).trim())) {
    diagnostic(
      diagnostics,
      'INVALID_RESOURCE_LIMIT',
      allowUnlimited
        ? 'Expected -1 or a byte value such as 512M or 1GiB'
        : 'Expected a byte value such as 512M or 1GiB',
      path
    );
    return undefined;
  }
  return String(value).trim();
}

function stringOrList(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  diagnostic(diagnostics, 'INVALID_COMMAND', 'Expected a string or an array of strings', path);
  return undefined;
}

function normalizeStringMap(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== 'string' || !entry.includes('=')) {
        diagnostic(diagnostics, 'INVALID_MAP_ENTRY', 'Expected KEY=value', `${path}[${index}]`);
        continue;
      }
      const separator = entry.indexOf('=');
      result[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return result;
  }
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'INVALID_MAP', 'Expected a mapping or KEY=value list', path);
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) result[key] = '';
    else {
      const normalized = scalarString(entry, `${path}.${key}`, diagnostics);
      if (normalized !== null) result[key] = normalized;
    }
  }
  return result;
}

function normalizeLabels(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]) {
  const labels = normalizeStringMap(value, path, diagnostics);
  if (!labels) return undefined;
  for (const key of Object.keys(labels)) {
    if (RESERVED_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      diagnostic(
        diagnostics,
        'RESERVED_LABEL',
        `Label ${key} is reserved by Docker Compose or Gateway`,
        `${path}.${key}`
      );
    }
  }
  return labels;
}

function normalizeExtraHosts(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return normalizeStringMap(value, path, diagnostics);

  const result: Record<string, string> = {};
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      diagnostic(diagnostics, 'INVALID_EXTRA_HOST', 'Expected HOST=ADDRESS or HOST:ADDRESS', `${path}[${index}]`);
      continue;
    }
    const separator = entry.includes('=') ? entry.indexOf('=') : entry.indexOf(':');
    if (separator <= 0 || separator === entry.length - 1) {
      diagnostic(diagnostics, 'INVALID_EXTRA_HOST', 'Expected HOST=ADDRESS or HOST:ADDRESS', `${path}[${index}]`);
      continue;
    }
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

function normalizePorts(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'INVALID_PORTS', 'Expected a list of ports', path);
    return undefined;
  }
  return value.flatMap((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof entry === 'number') return [{ target: entry, protocol: 'tcp' as const }];
    if (typeof entry === 'string') {
      const [address, protocolValue = 'tcp'] = entry.split('/');
      if (address.includes('-') || !['tcp', 'udp'].includes(protocolValue)) {
        diagnostic(diagnostics, 'UNSUPPORTED_PORT', 'Port ranges and unsupported protocols are not allowed', itemPath);
        return [];
      }
      const parts = address.split(':');
      const target = Number(parts.at(-1));
      const published = parts.length >= 2 ? Number(parts.at(-2)) : undefined;
      const hostIp = parts.length === 3 ? parts[0] : undefined;
      if (
        !Number.isInteger(target) ||
        target < 1 ||
        target > 65535 ||
        (published !== undefined && (!Number.isInteger(published) || published < 1 || published > 65535))
      ) {
        diagnostic(diagnostics, 'INVALID_PORT', 'Ports must be integers from 1 to 65535', itemPath);
        return [];
      }
      return [
        {
          target,
          ...(published ? { published } : {}),
          ...(hostIp ? { hostIp } : {}),
          protocol: protocolValue as 'tcp' | 'udp',
        },
      ];
    }
    if (isRecord(entry)) {
      const unsupported = Object.keys(entry).filter(
        (key) => !['target', 'published', 'protocol', 'host_ip'].includes(key)
      );
      if (unsupported.length > 0) {
        diagnostic(diagnostics, 'UNSUPPORTED_PORT', `Unsupported port fields: ${unsupported.join(', ')}`, itemPath);
        return [];
      }
      const target = Number(entry.target);
      const published = entry.published === undefined ? undefined : Number(entry.published);
      const protocol = entry.protocol === undefined ? 'tcp' : String(entry.protocol);
      if (
        !Number.isInteger(target) ||
        !['tcp', 'udp'].includes(protocol) ||
        (published !== undefined && !Number.isInteger(published))
      ) {
        diagnostic(diagnostics, 'INVALID_PORT', 'Invalid long-syntax port', itemPath);
        return [];
      }
      return [
        {
          target,
          ...(published ? { published } : {}),
          ...(entry.host_ip ? { hostIp: String(entry.host_ip) } : {}),
          protocol: protocol as 'tcp' | 'udp',
        },
      ];
    }
    diagnostic(diagnostics, 'INVALID_PORT', 'Expected a port string, number, or mapping', itemPath);
    return [];
  });
}

function isHostPath(value: string) {
  return (
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    value.includes('$')
  );
}

function normalizeServiceVolumes(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): DockerComposeNormalizedVolume[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'INVALID_VOLUMES', 'Expected a list of named-volume mounts', path);
    return undefined;
  }
  return value.flatMap((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof entry === 'string') {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) {
        diagnostic(diagnostics, 'ANONYMOUS_VOLUME', 'Only named source:target volumes are supported', itemPath);
        return [];
      }
      const [source, target, mode] = parts;
      if (isHostPath(source)) {
        diagnostic(diagnostics, 'HOST_BIND_FORBIDDEN', 'Host bind mounts are not supported', itemPath);
        return [];
      }
      if (!target.startsWith('/') || (mode && !['ro', 'rw'].includes(mode))) {
        diagnostic(diagnostics, 'INVALID_VOLUME', 'Invalid named-volume target or mode', itemPath);
        return [];
      }
      return [{ source, target, readOnly: mode === 'ro' } satisfies DockerComposeNormalizedVolume];
    }
    if (isRecord(entry)) {
      const unsupported = Object.keys(entry).filter((key) => !['type', 'source', 'target', 'read_only'].includes(key));
      if (unsupported.length > 0 || (entry.type !== undefined && entry.type !== 'volume')) {
        diagnostic(diagnostics, 'HOST_BIND_FORBIDDEN', 'Only long-syntax named volumes are supported', itemPath);
        return [];
      }
      if (typeof entry.source !== 'string' || typeof entry.target !== 'string' || isHostPath(entry.source)) {
        diagnostic(diagnostics, 'INVALID_VOLUME', 'Named volumes require string source and target', itemPath);
        return [];
      }
      return [
        {
          source: entry.source,
          target: entry.target,
          readOnly: entry.read_only === true,
        } satisfies DockerComposeNormalizedVolume,
      ];
    }
    diagnostic(diagnostics, 'INVALID_VOLUME', 'Expected a named-volume string or mapping', itemPath);
    return [];
  });
}

function normalizeDependsOn(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return Object.fromEntries(value.map((name) => [name, {}]));
  }
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'INVALID_DEPENDS_ON', 'Expected a service list or mapping', path);
    return undefined;
  }
  const result: Record<string, { condition?: string }> = {};
  for (const [name, config] of Object.entries(value)) {
    if (config === null) result[name] = {};
    else if (isRecord(config)) {
      const unsupported = Object.keys(config).filter((key) => key !== 'condition');
      if (unsupported.length > 0)
        diagnostic(
          diagnostics,
          'UNSUPPORTED_DEPENDS_ON',
          `Unsupported depends_on fields: ${unsupported.join(', ')}`,
          `${path}.${name}`
        );
      result[name] = config.condition ? { condition: String(config.condition) } : {};
    } else diagnostic(diagnostics, 'INVALID_DEPENDS_ON', 'Expected a depends_on mapping', `${path}.${name}`);
  }
  return result;
}

function normalizeNetworks(value: unknown, path: string, diagnostics: ComposeValidationDiagnostic[]) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'INVALID_NETWORKS', 'Expected a network list or mapping', path);
    return undefined;
  }
  for (const [name, config] of Object.entries(value)) {
    if (config !== null && (!isRecord(config) || Object.keys(config).some((key) => key !== 'aliases'))) {
      diagnostic(
        diagnostics,
        'UNSUPPORTED_NETWORK',
        'Only per-service network aliases are supported',
        `${path}.${name}`
      );
    }
  }
  return Object.keys(value);
}

function normalizeResourceMap(
  value: unknown,
  path: string,
  diagnostics: ComposeValidationDiagnostic[]
): Record<string, DockerComposeNormalizedResource> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'INVALID_RESOURCE_MAP', 'Expected a mapping', path);
    return undefined;
  }
  const result: Record<string, DockerComposeNormalizedResource> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (raw === null) {
      result[name] = {};
      continue;
    }
    if (!isRecord(raw)) {
      diagnostic(diagnostics, 'INVALID_RESOURCE', 'Expected a mapping', `${path}.${name}`);
      continue;
    }
    const unsupported = Object.keys(raw).filter((key) => !['external', 'name', 'driver', 'labels'].includes(key));
    if (unsupported.length > 0)
      diagnostic(
        diagnostics,
        'UNSUPPORTED_RESOURCE',
        `Unsupported fields: ${unsupported.join(', ')}`,
        `${path}.${name}`
      );
    if (raw.external !== undefined && typeof raw.external !== 'boolean') {
      diagnostic(diagnostics, 'INVALID_RESOURCE_EXTERNAL', 'Expected a boolean', `${path}.${name}.external`);
    }
    if (raw.name !== undefined && typeof raw.name !== 'string') {
      diagnostic(diagnostics, 'INVALID_RESOURCE_NAME', 'Expected a string', `${path}.${name}.name`);
    }
    if (raw.driver !== undefined && typeof raw.driver !== 'string') {
      diagnostic(diagnostics, 'INVALID_RESOURCE_DRIVER', 'Expected a string', `${path}.${name}.driver`);
    }
    result[name] = {
      ...(raw.external === true ? { external: true } : {}),
      ...(typeof raw.name === 'string' ? { externalName: raw.name } : {}),
      ...(typeof raw.driver === 'string' ? { driver: raw.driver } : {}),
      ...(raw.labels !== undefined
        ? { labels: normalizeLabels(raw.labels, `${path}.${name}.labels`, diagnostics) }
        : {}),
    };
  }
  return result;
}

function collectRequiredVariables(value: unknown, provided: Set<string>) {
  const required = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      for (const match of current.matchAll(VARIABLE_PATTERN)) {
        const [, name, operator] = match;
        if (!provided.has(name) && (!operator || operator.includes('?'))) required.add(name);
      }
    } else if (Array.isArray(current)) current.forEach(visit);
    else if (isRecord(current)) Object.values(current).forEach(visit);
  };
  visit(value);
  return [...required].sort();
}

export function validateComposeYaml(input: ComposeYamlInput): ComposeValidationResult {
  const diagnostics: ComposeValidationDiagnostic[] = [];
  if (Buffer.byteLength(input.yaml, 'utf8') > COMPOSE_YAML_MAX_BYTES) {
    diagnostic(diagnostics, 'YAML_TOO_LARGE', `Compose YAML must not exceed ${COMPOSE_YAML_MAX_BYTES} bytes`);
    return {
      valid: false,
      projectName: input.projectName,
      normalizedModel: null,
      configDigest: null,
      requiredVariables: [],
      diagnostics,
    };
  }

  const documents = parseAllDocuments(input.yaml, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    customTags: [],
    logLevel: 'silent',
  });
  if (documents.length !== 1) diagnostic(diagnostics, 'MULTIPLE_DOCUMENTS', 'Exactly one YAML document is required');
  const document = documents[0];
  for (const error of document?.errors ?? []) diagnostic(diagnostics, 'YAML_PARSE_ERROR', error.message);
  for (const warning of document?.warnings ?? [])
    diagnostic(diagnostics, 'YAML_WARNING', warning.message, undefined, 'warning');
  if (!document || document.errors.length > 0) {
    return {
      valid: false,
      projectName: input.projectName,
      normalizedModel: null,
      configDigest: null,
      requiredVariables: [],
      diagnostics,
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    diagnostic(diagnostics, 'YAML_CONVERSION_ERROR', error instanceof Error ? error.message : String(error));
    return {
      valid: false,
      projectName: input.projectName,
      normalizedModel: null,
      configDigest: null,
      requiredVariables: [],
      diagnostics,
    };
  }
  if (!isRecord(parsed)) {
    diagnostic(diagnostics, 'INVALID_DOCUMENT', 'Compose YAML must contain a mapping');
    return {
      valid: false,
      projectName: input.projectName,
      normalizedModel: null,
      configDigest: null,
      requiredVariables: [],
      diagnostics,
    };
  }

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key))
      diagnostic(diagnostics, 'UNSUPPORTED_TOP_LEVEL', `Unsupported top-level field: ${key}`, key);
  }
  if (parsed.name !== undefined && parsed.name !== input.projectName) {
    diagnostic(
      diagnostics,
      'PROJECT_NAME_MISMATCH',
      'Compose document name must match the Gateway project name',
      'name'
    );
  }
  if (parsed.version !== undefined)
    diagnostic(diagnostics, 'VERSION_IGNORED', 'The obsolete Compose version field is ignored', 'version', 'warning');
  if (!isRecord(parsed.services) || Object.keys(parsed.services).length === 0) {
    diagnostic(diagnostics, 'SERVICES_REQUIRED', 'At least one service is required', 'services');
  }

  const volumes = normalizeResourceMap(parsed.volumes, 'volumes', diagnostics);
  const networks = normalizeResourceMap(parsed.networks, 'networks', diagnostics);
  const services: Record<string, DockerComposeNormalizedService> = {};
  if (isRecord(parsed.services)) {
    for (const [serviceName, rawService] of Object.entries(parsed.services)) {
      const path = `services.${serviceName}`;
      if (!isRecord(rawService)) {
        diagnostic(diagnostics, 'INVALID_SERVICE', 'Service must be a mapping', path);
        continue;
      }
      for (const [key, message] of EXPLICITLY_REJECTED_SERVICE_KEYS) {
        if (key in rawService)
          diagnostic(
            diagnostics,
            key === 'build' ? 'BUILD_FORBIDDEN' : 'UNSUPPORTED_SERVICE_FIELD',
            message,
            `${path}.${key}`
          );
      }
      for (const key of Object.keys(rawService)) {
        if (!SERVICE_KEYS.has(key) && !EXPLICITLY_REJECTED_SERVICE_KEYS.has(key)) {
          diagnostic(diagnostics, 'UNSUPPORTED_SERVICE_FIELD', `Unsupported service field: ${key}`, `${path}.${key}`);
        }
      }
      if (typeof rawService.image !== 'string' || !rawService.image.trim()) {
        diagnostic(diagnostics, 'IMAGE_REQUIRED', 'Every service must use a pre-built image', `${path}.image`);
        continue;
      }
      const serviceVolumes = normalizeServiceVolumes(rawService.volumes, `${path}.volumes`, diagnostics);
      for (const mount of serviceVolumes ?? []) {
        if (!volumes?.[mount.source])
          diagnostic(
            diagnostics,
            'UNDECLARED_VOLUME',
            `Named volume ${mount.source} must be declared at top level`,
            `${path}.volumes`
          );
        else mount.external = volumes[mount.source].external === true;
      }
      const serviceNetworks = normalizeNetworks(rawService.networks, `${path}.networks`, diagnostics);
      for (const network of serviceNetworks ?? []) {
        if (network !== 'default' && !networks?.[network])
          diagnostic(
            diagnostics,
            'UNDECLARED_NETWORK',
            `Network ${network} must be declared at top level`,
            `${path}.networks`
          );
      }
      const restart = rawService.restart === undefined ? undefined : String(rawService.restart);
      if (restart && !['no', 'always', 'on-failure', 'unless-stopped'].includes(restart)) {
        diagnostic(diagnostics, 'UNSUPPORTED_RESTART', 'Unsupported restart policy', `${path}.restart`);
      }
      services[serviceName] = {
        image: rawService.image,
        ...(rawService.cpus !== undefined
          ? { cpus: nonNegativeNumber(rawService.cpus, `${path}.cpus`, diagnostics) }
          : {}),
        ...(rawService.cpu_shares !== undefined
          ? { cpuShares: nonNegativeInteger(rawService.cpu_shares, `${path}.cpu_shares`, diagnostics) }
          : {}),
        ...(rawService.mem_limit !== undefined
          ? { memoryLimit: byteValue(rawService.mem_limit, `${path}.mem_limit`, diagnostics) }
          : {}),
        ...(rawService.mem_reservation !== undefined
          ? {
              memoryReservation: byteValue(rawService.mem_reservation, `${path}.mem_reservation`, diagnostics),
            }
          : {}),
        ...(rawService.memswap_limit !== undefined
          ? {
              memorySwapLimit: byteValue(rawService.memswap_limit, `${path}.memswap_limit`, diagnostics, true),
            }
          : {}),
        ...(rawService.pids_limit !== undefined
          ? { pidsLimit: pidsLimit(rawService.pids_limit, `${path}.pids_limit`, diagnostics) }
          : {}),
        ...(rawService.environment !== undefined
          ? { environment: normalizeStringMap(rawService.environment, `${path}.environment`, diagnostics) }
          : {}),
        ...(rawService.command !== undefined
          ? { command: stringOrList(rawService.command, `${path}.command`, diagnostics) }
          : {}),
        ...(rawService.entrypoint !== undefined
          ? { entrypoint: stringOrList(rawService.entrypoint, `${path}.entrypoint`, diagnostics) }
          : {}),
        ...(typeof rawService.working_dir === 'string' ? { workingDir: rawService.working_dir } : {}),
        ...(typeof rawService.user === 'string' ? { user: rawService.user } : {}),
        ...(typeof rawService.hostname === 'string' ? { hostname: rawService.hostname } : {}),
        ...(rawService.extra_hosts !== undefined
          ? { extraHosts: normalizeExtraHosts(rawService.extra_hosts, `${path}.extra_hosts`, diagnostics) }
          : {}),
        ...(rawService.ports !== undefined
          ? { ports: normalizePorts(rawService.ports, `${path}.ports`, diagnostics) }
          : {}),
        ...(isRecord(rawService.healthcheck) ? { healthcheck: rawService.healthcheck } : {}),
        ...(rawService.depends_on !== undefined
          ? { dependsOn: normalizeDependsOn(rawService.depends_on, `${path}.depends_on`, diagnostics) }
          : {}),
        ...(restart && ['no', 'always', 'on-failure', 'unless-stopped'].includes(restart)
          ? { restart: restart as DockerComposeNormalizedService['restart'] }
          : {}),
        ...(serviceVolumes ? { volumes: serviceVolumes } : {}),
        ...(serviceNetworks ? { networks: serviceNetworks } : {}),
        ...(rawService.labels !== undefined
          ? { labels: normalizeLabels(rawService.labels, `${path}.labels`, diagnostics) }
          : {}),
      };
    }
  }

  const providedVariables = new Set([...Object.keys(input.variables), ...input.secretKeys]);
  const requiredVariables = collectRequiredVariables(parsed, providedVariables);
  for (const name of requiredVariables)
    diagnostic(diagnostics, 'VARIABLE_REQUIRED', `Variable ${name} requires a value or secret binding`, undefined);

  const valid = diagnostics.every((item) => item.severity !== 'error');
  const normalizedModel: DockerComposeNormalizedModel = {
    name: input.projectName,
    services,
    ...(volumes ? { volumes } : {}),
    ...(networks ? { networks } : {}),
  };
  const configDigest = createHash('sha256')
    .update(
      JSON.stringify(
        stableValue(
          Object.keys(input.variables).length || input.secretKeys.length
            ? {
                compose: parsed,
                variables: input.variables,
                secretKeys: [...new Set(input.secretKeys)].sort(),
              }
            : parsed
        )
      )
    )
    .digest('hex');
  return {
    valid,
    projectName: input.projectName,
    normalizedModel: valid ? normalizedModel : null,
    configDigest: valid ? configDigest : null,
    requiredVariables,
    diagnostics,
  };
}
