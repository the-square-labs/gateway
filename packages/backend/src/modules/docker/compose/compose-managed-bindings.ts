import { createHash } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { AppError } from '@/middleware/error-handler.js';

export interface ComposeServiceTarget {
  projectId: string;
  serviceName: string;
}

export interface ComposeManagedDatabasePatch {
  bindingId: string;
  networkName: string;
  hostAlias?: string;
  hostAddress?: string;
  environment: Record<string, string>;
}

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseYaml(yaml: string): Record<string, unknown> {
  const document = parseDocument(yaml, {
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    strict: true,
    customTags: [],
    logLevel: 'silent',
  });
  if (document.errors.length > 0) {
    throw new AppError(400, 'COMPOSE_YAML_INVALID', 'Compose YAML cannot be updated');
  }
  const value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  if (!isRecord(value)) throw new AppError(400, 'COMPOSE_YAML_INVALID', 'Compose YAML must contain a mapping');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function serviceRecord(root: Record<string, unknown>, serviceName: string): Record<string, unknown> {
  if (!isRecord(root.services) || !isRecord(root.services[serviceName])) {
    throw new AppError(404, 'COMPOSE_SERVICE_NOT_FOUND', 'Compose service not found');
  }
  return root.services[serviceName];
}

function environmentMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new AppError(409, 'COMPOSE_ENVIRONMENT_CONFLICT', 'Compose service environment cannot be updated safely');
      }
      const separator = entry.indexOf('=');
      result[separator < 0 ? entry : entry.slice(0, separator)] = separator < 0 ? '' : entry.slice(separator + 1);
    }
    return result;
  }
  if (!isRecord(value)) {
    throw new AppError(409, 'COMPOSE_ENVIRONMENT_CONFLICT', 'Compose service environment cannot be updated safely');
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry === null ? '' : String(entry)]));
}

function serviceNetworks(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === 'string')) {
      throw new AppError(409, 'COMPOSE_NETWORK_CONFLICT', 'Compose service networks cannot be updated safely');
    }
    return Object.fromEntries(value.map((entry) => [entry, null]));
  }
  if (!isRecord(value)) {
    throw new AppError(409, 'COMPOSE_NETWORK_CONFLICT', 'Compose service networks cannot be updated safely');
  }
  return { ...value };
}

function serviceExtraHosts(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const entry of value) {
      if (typeof entry !== 'string') {
        throw new AppError(409, 'COMPOSE_EXTRA_HOSTS_CONFLICT', 'Compose service extra_hosts cannot be updated safely');
      }
      const separator = entry.indexOf(':');
      if (separator <= 0 || separator === entry.length - 1) {
        throw new AppError(409, 'COMPOSE_EXTRA_HOSTS_CONFLICT', 'Compose service extra_hosts cannot be updated safely');
      }
      result[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return result;
  }
  if (!isRecord(value)) {
    throw new AppError(409, 'COMPOSE_EXTRA_HOSTS_CONFLICT', 'Compose service extra_hosts cannot be updated safely');
  }
  return Object.fromEntries(Object.entries(value).map(([host, address]) => [host, String(address)]));
}

function networkKey(bindingId: string) {
  return `gateway_db_${bindingId.replaceAll('-', '').slice(0, 16)}`;
}

export function composeBindingSecretKey(bindingId: string, environmentName: string) {
  const bindingPart = bindingId.replaceAll('-', '').slice(0, 16).toUpperCase();
  const environmentPart = createHash('sha256').update(environmentName).digest('hex').slice(0, 12).toUpperCase();
  return `GATEWAY_DB_${bindingPart}_${environmentPart}`;
}

export function encodeComposeServiceTarget(target: ComposeServiceTarget) {
  return `${target.projectId}:${encodeURIComponent(target.serviceName)}`;
}

export function decodeComposeServiceTarget(value: string): ComposeServiceTarget {
  const separator = value.indexOf(':');
  const projectId = separator < 0 ? '' : value.slice(0, separator);
  let serviceName = '';
  try {
    serviceName = separator < 0 ? '' : decodeURIComponent(value.slice(separator + 1));
  } catch {
    serviceName = '';
  }
  if (!PROJECT_ID_PATTERN.test(projectId) || !serviceName) {
    throw new AppError(400, 'INVALID_COMPOSE_SERVICE_TARGET', 'Compose service target is invalid');
  }
  return { projectId, serviceName };
}

export function addManagedDatabaseBindingToYaml(yaml: string, serviceName: string, patch: ComposeManagedDatabasePatch) {
  const root = parseYaml(yaml);
  const service = serviceRecord(root, serviceName);
  const environment = environmentMap(service.environment);
  for (const name of Object.keys(patch.environment)) {
    const secretKey = composeBindingSecretKey(patch.bindingId, name);
    if (Object.hasOwn(environment, name) && environment[name] !== `\${${secretKey}}`) {
      throw new AppError(409, 'COMPOSE_ENVIRONMENT_CONFLICT', `Compose service already defines ${name}`);
    }
    environment[name] = `\${${secretKey}}`;
  }
  service.environment = environment;

  if (patch.hostAlias && patch.hostAddress) {
    const extraHosts = serviceExtraHosts(service.extra_hosts);
    if (extraHosts[patch.hostAlias] !== undefined && extraHosts[patch.hostAlias] !== patch.hostAddress) {
      throw new AppError(409, 'COMPOSE_EXTRA_HOSTS_CONFLICT', `Compose service already defines ${patch.hostAlias}`);
    }
    extraHosts[patch.hostAlias] = patch.hostAddress;
    service.extra_hosts = extraHosts;
  }

  const logicalNetwork = networkKey(patch.bindingId);
  const networks = isRecord(root.networks) ? { ...root.networks } : {};
  const existingNetwork = networks[logicalNetwork];
  if (
    existingNetwork !== undefined &&
    (!isRecord(existingNetwork) || existingNetwork.external !== true || existingNetwork.name !== patch.networkName)
  ) {
    throw new AppError(409, 'COMPOSE_NETWORK_CONFLICT', 'Compose project already defines the managed link network');
  }
  networks[logicalNetwork] = { external: true, name: patch.networkName };
  root.networks = networks;

  const attachedNetworks = serviceNetworks(service.networks);
  attachedNetworks[logicalNetwork] ??= null;
  service.networks = attachedNetworks;

  return {
    yaml: stringify(root, { lineWidth: 0 }),
    secretKeys: Object.keys(patch.environment).map((name) => composeBindingSecretKey(patch.bindingId, name)),
  };
}

/** Availability backends are reached through placement Secure Links, never host-published Compose ports. */
export function removeComposePublishedPortsForAvailability(yaml: string) {
  const root = parseYaml(yaml);
  if (!isRecord(root.services)) return stringify(root, { lineWidth: 0 });
  for (const service of Object.values(root.services)) {
    if (isRecord(service)) delete service.ports;
  }
  return stringify(root, { lineWidth: 0 });
}

export function removeManagedDatabaseBindingFromYaml(
  yaml: string,
  serviceName: string,
  patch: ComposeManagedDatabasePatch
) {
  const root = parseYaml(yaml);
  const service = serviceRecord(root, serviceName);
  const environment = environmentMap(service.environment);
  for (const name of Object.keys(patch.environment)) {
    const expected = `\${${composeBindingSecretKey(patch.bindingId, name)}}`;
    if (environment[name] !== undefined && environment[name] !== expected) {
      throw new AppError(409, 'COMPOSE_MANAGED_BINDING_CHANGED', `Managed environment ${name} was changed`);
    }
    delete environment[name];
  }
  if (Object.keys(environment).length > 0) service.environment = environment;
  else delete service.environment;

  if (patch.hostAlias && patch.hostAddress) {
    const extraHosts = serviceExtraHosts(service.extra_hosts);
    if (extraHosts[patch.hostAlias] !== undefined && extraHosts[patch.hostAlias] !== patch.hostAddress) {
      throw new AppError(409, 'COMPOSE_MANAGED_BINDING_CHANGED', `Managed host ${patch.hostAlias} was changed`);
    }
    delete extraHosts[patch.hostAlias];
    if (Object.keys(extraHosts).length > 0) service.extra_hosts = extraHosts;
    else delete service.extra_hosts;
  }

  const logicalNetwork = networkKey(patch.bindingId);
  const attachedNetworks = serviceNetworks(service.networks);
  delete attachedNetworks[logicalNetwork];
  if (Object.keys(attachedNetworks).length > 0) service.networks = attachedNetworks;
  else delete service.networks;

  if (isRecord(root.networks)) {
    const network = root.networks[logicalNetwork];
    if (
      network !== undefined &&
      (!isRecord(network) || network.external !== true || network.name !== patch.networkName)
    ) {
      throw new AppError(409, 'COMPOSE_MANAGED_BINDING_CHANGED', 'Managed link network was changed');
    }
    delete root.networks[logicalNetwork];
    if (Object.keys(root.networks).length === 0) delete root.networks;
  }

  return {
    yaml: stringify(root, { lineWidth: 0 }),
    secretKeys: Object.keys(patch.environment).map((name) => composeBindingSecretKey(patch.bindingId, name)),
  };
}

export function assertManagedDatabaseBindingInYaml(
  yaml: string,
  serviceName: string,
  patch: ComposeManagedDatabasePatch
) {
  const root = parseYaml(yaml);
  const service = serviceRecord(root, serviceName);
  const environment = environmentMap(service.environment);
  for (const name of Object.keys(patch.environment)) {
    if (environment[name] !== `\${${composeBindingSecretKey(patch.bindingId, name)}}`) {
      throw new AppError(
        409,
        'COMPOSE_MANAGED_BINDING_REQUIRED',
        `Compose service must preserve managed environment ${name}`
      );
    }
  }
  if (patch.hostAlias && patch.hostAddress) {
    const extraHosts = serviceExtraHosts(service.extra_hosts);
    if (extraHosts[patch.hostAlias] !== patch.hostAddress) {
      throw new AppError(
        409,
        'COMPOSE_MANAGED_BINDING_REQUIRED',
        `Compose service must preserve managed host ${patch.hostAlias}`
      );
    }
  }
  const logicalNetwork = networkKey(patch.bindingId);
  const network = isRecord(root.networks) ? root.networks[logicalNetwork] : undefined;
  if (!isRecord(network) || network.external !== true || network.name !== patch.networkName) {
    throw new AppError(
      409,
      'COMPOSE_MANAGED_BINDING_REQUIRED',
      'Compose project must preserve its managed link network'
    );
  }
  if (!Object.hasOwn(serviceNetworks(service.networks), logicalNetwork)) {
    throw new AppError(
      409,
      'COMPOSE_MANAGED_BINDING_REQUIRED',
      'Compose service must preserve its managed link network'
    );
  }
}
