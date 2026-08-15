import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { stripRawProxyConfigForProgrammatic } from '@/modules/proxy/raw-visibility.js';
import type { AIToolDefinition } from './ai.types.js';
import { getAIToolResourceId } from './ai-tool-policy-metadata.js';
import {
  AI_TOOL_ANY_SCOPE_REQUIREMENTS as ANY_SCOPE_TOOL_REQUIREMENTS,
  AI_BROAD_ONLY_TOOL_SCOPES as BROAD_ONLY_TOOL_SCOPES,
  AI_DIRECT_DATABASE_VIEW_TOOLS as DIRECT_DATABASE_VIEW_TOOLS,
  AI_DIRECT_RAW_READ_TOOLS as DIRECT_RAW_READ_TOOLS,
} from './ai-tool-scope-policy.js';

const PROXY_HOST_UPDATE_FIELDS = [
  'type',
  'nodeId',
  'domainNames',
  'forwardHost',
  'forwardPort',
  'forwardScheme',
  'sslEnabled',
  'sslForced',
  'http2Support',
  'websocketSupport',
  'sslCertificateId',
  'internalCertificateId',
  'redirectUrl',
  'redirectStatusCode',
  'customHeaders',
  'cacheEnabled',
  'cacheOptions',
  'rateLimitEnabled',
  'rateLimitOptions',
  'customRewrites',
  'accessListId',
  'folderId',
  'nginxTemplateId',
  'templateVariables',
  'healthCheckEnabled',
  'healthCheckUrl',
  'healthCheckInterval',
  'healthCheckExpectedStatus',
  'healthCheckExpectedBody',
  'healthCheckBodyMatchMode',
  'healthCheckSlowThreshold',
  'enabled',
] as const;

function caTypeViewScope(type: string): 'pki:ca:view:root' | 'pki:ca:view:intermediate' {
  return type === 'root' ? 'pki:ca:view:root' : 'pki:ca:view:intermediate';
}

function caTypeRevokeScope(type: string): 'pki:ca:revoke:root' | 'pki:ca:revoke:intermediate' {
  return type === 'root' ? 'pki:ca:revoke:root' : 'pki:ca:revoke:intermediate';
}

function dashboardStatsOptionsForScopes(scopes: string[]) {
  return {
    allowedCaTypes: [
      hasScope(scopes, 'pki:ca:view:root') ? 'root' : null,
      hasScope(scopes, 'pki:ca:view:intermediate') ? 'intermediate' : null,
    ].filter((type): type is 'root' | 'intermediate' => !!type),
    allowedProxyHostIds: hasScope(scopes, 'proxy:view') ? undefined : getResourceScopedIds(scopes, 'proxy:view'),
    allowedSslCertificateIds: hasScope(scopes, 'ssl:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'ssl:cert:view'),
    allowedPkiCertificateIds: hasScope(scopes, 'pki:cert:view')
      ? undefined
      : getResourceScopedIds(scopes, 'pki:cert:view'),
    allowedNodeIds: hasScope(scopes, 'nodes:details') ? undefined : getResourceScopedIds(scopes, 'nodes:details'),
  };
}

function allowedResourceIdsForScopes(scopes: string[], baseScope: string): string[] | undefined {
  return hasScope(scopes, baseScope) ? undefined : getResourceScopedIds(scopes, baseScope);
}

function directResourceIdsForScopes(scopes: string[], baseScope: string): string[] | undefined {
  if (scopes.includes(baseScope)) return undefined;
  const prefix = `${baseScope}:`;
  const ids = scopes.filter((scope) => scope.startsWith(prefix)).map((scope) => scope.slice(prefix.length));
  return [...new Set(ids)];
}

const SENSITIVE_TOOL_ARG_RE =
  /(?:password|passwd|secret|signingsecret|privatekey|private_key|token|authorization|cookie|apikey|api_key|clientsecret|client_secret|refresh)/i;

function redactToolArgs(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 8) return '[REDACTED_DEPTH_LIMIT]';

  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgs(item, depth + 1));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_TOOL_ARG_RE.test(key) ? '[REDACTED]' : redactToolArgs(nested, depth + 1);
  }
  return redacted;
}

function getToolResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | undefined,
  args: Record<string, unknown>
): string {
  return getAIToolResourceId(tool, args);
}

function getToolAuthorizationResourceId(
  tool: Pick<AIToolDefinition, 'targetIdentity'> | string | undefined,
  args: Record<string, unknown>
): string {
  return getToolResourceId(typeof tool === 'string' ? undefined : tool, args);
}

function isMutatingTool(toolDef: { destructive: boolean; invalidateStores: string[] }): boolean {
  return toolDef.destructive || toolDef.invalidateStores.length > 0;
}

function hasToolExecutionScope(
  scopes: string[],
  toolName: string,
  requiredScope: string | undefined,
  args: Record<string, unknown>,
  tool?: Pick<AIToolDefinition, 'targetIdentity' | 'requiredScopes'>
): boolean {
  if (!requiredScope) return false;
  if (tool?.requiredScopes && !tool.requiredScopes.every((scope) => hasScopeBase(scopes, scope))) return false;
  if (
    requiredScope.startsWith('docker:containers:') &&
    requiredScope !== 'docker:containers:create' &&
    hasScopeBase(scopes, requiredScope)
  ) {
    return true;
  }
  const anyRequirements = ANY_SCOPE_TOOL_REQUIREMENTS[toolName];
  if (anyRequirements) return anyRequirements.some((scope) => hasScopeBase(scopes, scope));
  if (BROAD_ONLY_TOOL_SCOPES.has(toolName)) return hasScope(scopes, requiredScope);
  if (DIRECT_DATABASE_VIEW_TOOLS.has(toolName)) {
    return scopes.includes(requiredScope) || scopes.some((scope) => scope.startsWith(`${requiredScope}:`));
  }
  if (DIRECT_RAW_READ_TOOLS.has(toolName)) {
    const resourceId = getToolAuthorizationResourceId(tool, args);
    if (scopes.includes(requiredScope)) return true;
    return resourceId
      ? scopes.includes(`${requiredScope}:${resourceId}`)
      : scopes.some((scope) => scope.startsWith(`${requiredScope}:`));
  }
  const resourceId = getToolAuthorizationResourceId(tool, args);
  return resourceId ? hasScopeForResource(scopes, requiredScope, resourceId) : hasScopeBase(scopes, requiredScope);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: Record<string, unknown>[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') total += estimateTokens(msg.content);
    const toolCalls = msg.tool_calls as Array<{ function?: { arguments?: string } }> | undefined;
    if (toolCalls) {
      for (const tc of toolCalls) {
        total += estimateTokens(tc.function?.arguments || '');
        total += 20;
      }
    }
    total += 4;
  }
  return total;
}

function compactProxyHostForAgent(host: Record<string, any>) {
  const safeHost = stripRawProxyConfigForProgrammatic(host);
  return {
    id: safeHost.id,
    slug: safeHost.slug,
    type: safeHost.type,
    domainNames: safeHost.domainNames,
    enabled: safeHost.enabled,
    nodeId: safeHost.nodeId,
    forwardScheme: safeHost.forwardScheme,
    forwardHost: safeHost.forwardHost,
    forwardPort: safeHost.forwardPort,
    sslEnabled: safeHost.sslEnabled,
    sslForced: safeHost.sslForced,
    sslCertificateId: safeHost.sslCertificateId,
    accessListId: safeHost.accessListId,
    healthCheckEnabled: safeHost.healthCheckEnabled,
    healthStatus: safeHost.healthStatus,
    effectiveHealthStatus: safeHost.effectiveHealthStatus,
    lastHealthCheckAt: safeHost.lastHealthCheckAt,
    createdAt: safeHost.createdAt,
    updatedAt: safeHost.updatedAt,
  };
}

function compactDockerContainerForAgent(container: Record<string, any>) {
  const name = ((container.name ?? container.Name ?? '') as string).replace(/^\//, '');
  const ports = container.ports ?? container.Ports;
  return {
    id: container.id ?? container.Id,
    name,
    image: container.image ?? container.Image,
    state: container.state ?? container.State,
    status: container.status ?? container.Status,
    created: container.created ?? container.Created,
    ports: Array.isArray(ports) ? ports.slice(0, 64) : ports,
    portsCount: Array.isArray(ports) ? ports.length : undefined,
    portsTruncated: Array.isArray(ports) && ports.length > 64,
    kind: container.kind ?? 'container',
    deploymentId: container.deploymentId,
    activeSlot: container.activeSlot,
    healthCheckId: container.healthCheckId,
    healthCheckEnabled: container.healthCheckEnabled,
    healthStatus: container.healthStatus,
    lastHealthCheckAt: container.lastHealthCheckAt,
    folderId: container.folderId,
    folderIsSystem: container.folderIsSystem,
    folderSortOrder: container.folderSortOrder,
    _transition: container._transition,
  };
}

function compactDockerDeploymentForAgent(deployment: Record<string, any>) {
  const healthCheck = deployment.healthCheck;
  const primaryRoute = Array.isArray(deployment.routes)
    ? (deployment.routes.find((route: any) => route.isPrimary) ?? deployment.routes[0])
    : undefined;
  return {
    id: deployment.id,
    nodeId: deployment.nodeId,
    name: deployment.name,
    status: deployment.status,
    activeSlot: deployment.activeSlot,
    desiredImage: deployment.desiredConfig?.image,
    primaryRoute: primaryRoute
      ? {
          hostPort: primaryRoute.hostPort,
          containerPort: primaryRoute.containerPort,
          host: primaryRoute.host,
          path: primaryRoute.path,
        }
      : null,
    slots: Array.isArray(deployment.slots)
      ? deployment.slots.map((slot: any) => ({
          slot: slot.slot,
          status: slot.status,
          image: slot.image,
          containerId: slot.containerId,
        }))
      : [],
    healthCheck: healthCheck
      ? {
          id: healthCheck.id,
          enabled: healthCheck.enabled,
          healthStatus: healthCheck.healthStatus,
          lastHealthCheckAt: healthCheck.lastHealthCheckAt,
        }
      : null,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    _transition: deployment._transition,
  };
}

const AGENT_LIST_RESULT_MAX = 1000;
const AGENT_PAGE_LIMIT_MAX = 100;
const AGENT_PAGE_MAX = 1000;
const AGENT_IMAGE_REF_PREVIEW_MAX = 20;
const AGENT_VOLUME_USED_BY_PREVIEW_MAX = 100;

function agentPageLimit(value: unknown, fallback = 50) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), AGENT_PAGE_LIMIT_MAX);
}

function agentPage(value: unknown, fallback = 1) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), 1), AGENT_PAGE_MAX);
}

function compactAgentList<T>(items: T[]) {
  const truncated = items.length > AGENT_LIST_RESULT_MAX;
  return {
    data: truncated ? items.slice(0, AGENT_LIST_RESULT_MAX) : items,
    total: items.length,
    limit: AGENT_LIST_RESULT_MAX,
    truncated,
  };
}

function compactDockerImageForAgent(image: Record<string, any>) {
  const repoTags = image.repoTags ?? image.RepoTags;
  const repoDigests = image.repoDigests ?? image.RepoDigests;
  return {
    id: image.id ?? image.Id,
    parentId: image.parentId ?? image.ParentId,
    repoTags: Array.isArray(repoTags) ? repoTags.slice(0, AGENT_IMAGE_REF_PREVIEW_MAX) : repoTags,
    repoTagsCount: Array.isArray(repoTags) ? repoTags.length : undefined,
    repoTagsTruncated: Array.isArray(repoTags) && repoTags.length > AGENT_IMAGE_REF_PREVIEW_MAX,
    repoDigests: Array.isArray(repoDigests) ? repoDigests.slice(0, AGENT_IMAGE_REF_PREVIEW_MAX) : repoDigests,
    repoDigestsCount: Array.isArray(repoDigests) ? repoDigests.length : undefined,
    repoDigestsTruncated: Array.isArray(repoDigests) && repoDigests.length > AGENT_IMAGE_REF_PREVIEW_MAX,
    created: image.created ?? image.Created,
    size: image.size ?? image.Size,
    virtualSize: image.virtualSize ?? image.VirtualSize,
    sharedSize: image.sharedSize ?? image.SharedSize,
    containers: image.containers ?? image.Containers,
  };
}

function hasRegistryHost(imageRef: string) {
  const firstSegment = imageRef.split('/')[0] ?? '';
  return firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');
}

function compactDockerVolumeForAgent(volume: Record<string, any>) {
  const usedBy = volume.usedBy ?? volume.UsedBy;
  return {
    name: volume.name ?? volume.Name,
    driver: volume.driver ?? volume.Driver,
    mountpoint: volume.mountpoint ?? volume.Mountpoint,
    scope: volume.scope ?? volume.Scope,
    createdAt: volume.createdAt ?? volume.CreatedAt,
    usedBy: Array.isArray(usedBy) ? usedBy.slice(0, AGENT_VOLUME_USED_BY_PREVIEW_MAX) : usedBy,
    usedByCount: Array.isArray(usedBy) ? usedBy.length : undefined,
    usedByTruncated: Array.isArray(usedBy) && usedBy.length > AGENT_VOLUME_USED_BY_PREVIEW_MAX,
  };
}

function compactDockerNetworkForAgent(network: Record<string, any>) {
  const containers = network.containers ?? network.Containers;
  return {
    id: network.id ?? network.Id,
    name: network.name ?? network.Name,
    driver: network.driver ?? network.Driver,
    scope: network.scope ?? network.Scope,
    created: network.created ?? network.Created,
    internal: network.internal ?? network.Internal,
    attachable: network.attachable ?? network.Attachable,
    ingress: network.ingress ?? network.Ingress,
    containersCount: containers && typeof containers === 'object' ? Object.keys(containers).length : undefined,
  };
}

function textMatchesSearch(values: unknown[], search: unknown) {
  if (typeof search !== 'string' || search.trim() === '') return true;
  const query = search.trim().toLowerCase();
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => value !== undefined && value !== null)
    .join(' ')
    .toLowerCase()
    .includes(query);
}

function dockerContainerMatchesSearch(container: Record<string, any>, search: unknown) {
  const ports = container.ports ?? container.Ports;
  const portText = Array.isArray(ports)
    ? ports.map((port: any) => [port.ip, port.publicPort, port.privatePort, port.type].join(' '))
    : [];
  return textMatchesSearch(
    [
      container.id ?? container.Id,
      container.name ?? container.Name,
      container.image ?? container.Image,
      container.state ?? container.State,
      container.status ?? container.Status,
      container.kind,
      container.deploymentId,
      portText,
    ],
    search
  );
}

function dockerDeploymentMatchesSearch(deployment: Record<string, any>, search: unknown) {
  const routes = Array.isArray(deployment.routes) ? deployment.routes : [];
  const routeText = routes.map((route: any) =>
    [route.host, route.path, route.hostPort, route.containerPort].filter(Boolean).join(' ')
  );
  return textMatchesSearch(
    [
      deployment.id,
      deployment.nodeId,
      deployment.name,
      deployment.status,
      deployment.activeSlot,
      deployment.desiredConfig?.image,
      routeText,
    ],
    search
  );
}

function dockerImageMatchesSearch(image: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      image.id ?? image.Id,
      image.parentId ?? image.ParentId,
      image.repoTags ?? image.RepoTags,
      image.repoDigests ?? image.RepoDigests,
    ],
    search
  );
}

function dockerVolumeMatchesSearch(volume: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      volume.name ?? volume.Name,
      volume.driver ?? volume.Driver,
      volume.mountpoint ?? volume.Mountpoint,
      volume.scope ?? volume.Scope,
      volume.usedBy ?? volume.UsedBy,
    ],
    search
  );
}

function dockerNetworkMatchesSearch(network: Record<string, any>, search: unknown) {
  return textMatchesSearch(
    [
      network.id ?? network.Id,
      network.name ?? network.Name,
      network.driver ?? network.Driver,
      network.scope ?? network.Scope,
    ],
    search
  );
}

export const aiServiceTestHelpers = {
  agentPage,
  agentPageLimit,
  compactAgentList,
  dockerContainerMatchesSearch,
  getToolAuthorizationResourceId,
  hasRegistryHost,
  redactToolArgs,
};

export {
  agentPage,
  agentPageLimit,
  allowedResourceIdsForScopes,
  caTypeRevokeScope,
  caTypeViewScope,
  compactAgentList,
  compactDockerContainerForAgent,
  compactDockerDeploymentForAgent,
  compactDockerImageForAgent,
  compactDockerNetworkForAgent,
  compactDockerVolumeForAgent,
  compactProxyHostForAgent,
  dashboardStatsOptionsForScopes,
  directResourceIdsForScopes,
  dockerContainerMatchesSearch,
  dockerDeploymentMatchesSearch,
  dockerImageMatchesSearch,
  dockerNetworkMatchesSearch,
  dockerVolumeMatchesSearch,
  estimateMessagesTokens,
  estimateTokens,
  getToolResourceId,
  hasRegistryHost,
  hasToolExecutionScope,
  isMutatingTool,
  PROXY_HOST_UPDATE_FIELDS,
  redactToolArgs,
  textMatchesSearch,
};
