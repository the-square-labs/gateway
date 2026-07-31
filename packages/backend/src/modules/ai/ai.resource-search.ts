import { getResourceScopedIds, hasScope, hasScopeBase, hasScopeForResource } from '@/lib/permissions.js';
import { dockerScopedNodeIds } from '@/modules/docker/docker-access-resource.service.js';
import type { NodesService } from '@/modules/nodes/nodes.service.js';
import type { User } from '@/types.js';
import { textMatchesSearch } from './ai.service-helpers.js';

type ExecuteToolInternal = (user: User, toolName: string, args: Record<string, unknown>) => Promise<unknown>;

type ResourceSearchDeps = {
  executeToolInternal: ExecuteToolInternal;
  nodesService: NodesService;
};

export async function findResource(deps: ResourceSearchDeps, user: User, args: Record<string, unknown>) {
  const query = String(args.query ?? '').trim();
  const requestedTypes = Array.isArray(args.types)
    ? new Set(args.types.map((type) => String(type).trim()).filter(Boolean))
    : new Set<string>();
  if (!query && requestedTypes.size === 0) throw new Error('query or types is required');

  const typeWanted = (...types: string[]) =>
    requestedTypes.size === 0 || types.some((type) => requestedTypes.has(type));
  const limitValue = typeof args.limit === 'number' ? args.limit : Number(args.limit);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.trunc(limitValue), 1), 50) : 25;
  const results: Array<Record<string, unknown>> = [];
  const errors: Array<{ type: string; error: string }> = [];

  const itemsOf = (value: unknown): Record<string, any>[] => {
    if (Array.isArray(value)) return value as Record<string, any>[];
    if (value && typeof value === 'object' && Array.isArray((value as any).data)) return (value as any).data;
    return [];
  };
  const add = (
    type: string,
    item: Record<string, any>,
    options: {
      id?: unknown;
      name?: unknown;
      nodeId?: unknown;
      nodeSlug?: unknown;
      skipMatch?: boolean;
    } = {}
  ) => {
    if (results.length >= limit) return;
    if (
      !options.skipMatch &&
      !textMatchesSearch(
        [
          options.id,
          options.name,
          item.id,
          item.name,
          item.title,
          item.hostname,
          item.domain,
          item.domainNames,
          item.commonName,
          item.serialNumber,
          item.repoTags,
          item.image,
          item.status,
        ],
        query
      )
    ) {
      return;
    }
    const id = String(options.id ?? item.id ?? item.name ?? item.domain ?? '');
    results.push({
      type,
      id,
      name: options.name ?? item.name ?? item.title ?? item.hostname ?? item.domain ?? item.commonName ?? item.id ?? id,
      nodeId: options.nodeId ?? item.nodeId,
      nodeSlug: options.nodeSlug ?? item.nodeSlug,
      summary: item,
    });
  };
  const collect = async (
    type: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    map: (item: Record<string, any>) => {
      id?: unknown;
      name?: unknown;
      nodeId?: unknown;
      nodeSlug?: unknown;
    } = () => ({})
  ) => {
    if (results.length >= limit) return;
    try {
      const serviceFiltered = toolArgs.search === query;
      for (const item of itemsOf(await deps.executeToolInternal(user, toolName, toolArgs))) {
        add(type, item, { ...map(item), skipMatch: serviceFiltered });
        if (results.length >= limit) break;
      }
    } catch (err) {
      errors.push({ type, error: err instanceof Error ? err.message : 'search failed' });
    }
  };
  const flattenCas = (cas: Record<string, any>[]): Record<string, any>[] =>
    cas.flatMap((ca) => [ca, ...(Array.isArray(ca.children) ? flattenCas(ca.children) : [])]);

  if (typeWanted('node') && hasScopeBase(user.scopes, 'nodes:details')) {
    await collect('node', 'list_nodes', { search: query, limit }, (node) => ({
      id: node.id,
      name: node.displayName || node.hostname,
    }));
  }
  if (typeWanted('proxy_host') && hasScopeBase(user.scopes, 'proxy:view')) {
    await collect('proxy_host', 'list_proxy_hosts', { search: query, limit }, (host) => ({
      id: host.id,
      name: Array.isArray(host.domainNames) ? host.domainNames.join(', ') : host.id,
      nodeId: host.nodeId,
    }));
  }
  if (typeWanted('proxy_template') && hasScopeBase(user.scopes, 'proxy:templates:view')) {
    await collect('proxy_template', 'manage_proxy_template', { operation: 'list' });
  }
  if (typeWanted('ssl_certificate') && hasScopeBase(user.scopes, 'ssl:cert:view')) {
    await collect('ssl_certificate', 'list_ssl_certificates', { search: query, limit }, (cert) => ({
      id: cert.id,
      name: cert.name || cert.commonName || (Array.isArray(cert.domains) ? cert.domains.join(', ') : cert.id),
    }));
  }
  if (typeWanted('domain') && hasScopeBase(user.scopes, 'domains:view')) {
    await collect('domain', 'list_domains', { search: query, limit }, (domain) => ({
      id: domain.id,
      name: domain.domain,
    }));
  }
  if (typeWanted('access_list') && hasScopeBase(user.scopes, 'acl:view')) {
    await collect('access_list', 'list_access_lists', { search: query, limit });
  }
  if (
    typeWanted('ca') &&
    (hasScope(user.scopes, 'pki:ca:view:root') || hasScope(user.scopes, 'pki:ca:view:intermediate'))
  ) {
    try {
      for (const ca of flattenCas(itemsOf(await deps.executeToolInternal(user, 'list_cas', {})))) {
        add('ca', ca, { id: ca.id, name: ca.commonName });
        if (results.length >= limit) break;
      }
    } catch (err) {
      errors.push({ type: 'ca', error: err instanceof Error ? err.message : 'search failed' });
    }
  }
  if (typeWanted('pki_certificate') && hasScopeBase(user.scopes, 'pki:cert:view')) {
    await collect('pki_certificate', 'list_certificates', { search: query, limit }, (cert) => ({
      id: cert.id,
      name: cert.commonName || cert.serialNumber,
    }));
  }
  if (typeWanted('pki_template') && hasScopeBase(user.scopes, 'pki:templates:view')) {
    await collect('pki_template', 'list_templates', {}, (template) => ({
      id: template.id,
      name: template.name,
    }));
  }
  if (typeWanted('database') && hasScopeBase(user.scopes, 'databases:view')) {
    await collect('database', 'list_databases', { search: query, limit }, (database) => ({
      id: database.id,
      name: database.name,
    }));
  }
  if (typeWanted('logging_environment') && hasScopeBase(user.scopes, 'logs:environments:view')) {
    await collect('logging_environment', 'manage_logging', {
      resource: 'environment',
      operation: 'list',
      search: query,
      allowedIds:
        hasScope(user.scopes, 'logs:manage') || hasScope(user.scopes, 'logs:environments:view')
          ? undefined
          : getResourceScopedIds(user.scopes, 'logs:environments:view'),
    });
  }
  if (typeWanted('logging_schema') && hasScopeBase(user.scopes, 'logs:schemas:view')) {
    await collect('logging_schema', 'manage_logging', {
      resource: 'schema',
      operation: 'list',
      search: query,
      allowedIds:
        hasScope(user.scopes, 'logs:manage') || hasScope(user.scopes, 'logs:schemas:view')
          ? undefined
          : getResourceScopedIds(user.scopes, 'logs:schemas:view'),
    });
  }
  if (typeWanted('status_page_service') && hasScope(user.scopes, 'status-page:view')) {
    await collect('status_page_service', 'manage_status_page', { resource: 'services', operation: 'list' });
  }
  if (typeWanted('status_page_incident') && hasScope(user.scopes, 'status-page:view')) {
    await collect('status_page_incident', 'manage_status_page', {
      resource: 'incidents',
      operation: 'list',
      page: 1,
      limit,
    });
  }
  if (
    typeWanted('notification_rule') &&
    (hasScope(user.scopes, 'notifications:view') || hasScope(user.scopes, 'notifications:alerts:view'))
  ) {
    await collect('notification_rule', 'list_alert_rules', {});
  }
  if (
    typeWanted('notification_webhook') &&
    (hasScope(user.scopes, 'notifications:view') || hasScope(user.scopes, 'notifications:webhooks:view'))
  ) {
    await collect('notification_webhook', 'list_webhooks', {});
  }

  const dockerTypes = ['docker_container', 'docker_deployment', 'docker_image', 'docker_volume', 'docker_network'];
  if (dockerTypes.some((type) => typeWanted(type))) {
    const dockerNodes = await findDockerSearchNodes(
      deps.nodesService,
      user,
      typeof args.nodeId === 'string' ? args.nodeId : undefined
    );
    for (const node of dockerNodes) {
      if (results.length >= limit) break;
      const nodeId = node.id;
      if (typeWanted('docker_container') && hasScopeBase(user.scopes, 'docker:containers:view')) {
        await collect('docker_container', 'list_docker_containers', { nodeId, search: query }, (container) => ({
          id: container.id,
          name: container.name,
          nodeId,
          nodeSlug: node.slug,
        }));
      }
      if (typeWanted('docker_deployment') && hasScopeBase(user.scopes, 'docker:containers:view')) {
        await collect('docker_deployment', 'list_docker_deployments', { nodeId, search: query }, (deployment) => ({
          id: deployment.id,
          name: deployment.name,
          nodeId,
          nodeSlug: node.slug,
        }));
      }
      if (typeWanted('docker_image') && hasScopeForResource(user.scopes, 'docker:images:view', nodeId)) {
        await collect('docker_image', 'list_docker_images', { nodeId, search: query }, (image) => ({
          id: image.id,
          name: Array.isArray(image.repoTags) ? image.repoTags[0] : image.id,
          nodeId,
          nodeSlug: node.slug,
        }));
      }
      if (typeWanted('docker_volume') && hasScopeForResource(user.scopes, 'docker:volumes:view', nodeId)) {
        await collect('docker_volume', 'list_docker_volumes', { nodeId, search: query }, (volume) => ({
          id: volume.name,
          name: volume.name,
          nodeId,
          nodeSlug: node.slug,
        }));
      }
      if (typeWanted('docker_network') && hasScopeForResource(user.scopes, 'docker:networks:view', nodeId)) {
        await collect('docker_network', 'list_docker_networks', { nodeId, search: query }, (network) => ({
          id: network.id,
          name: network.name,
          nodeId,
          nodeSlug: node.slug,
        }));
      }
    }
  }
  if (typeWanted('docker_registry') && hasScopeBase(user.scopes, 'docker:registries:view')) {
    await collect('docker_registry', 'manage_docker_registry', { operation: 'list' });
  }

  return {
    query,
    results,
    total: results.length,
    truncated: results.length >= limit,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function findDockerSearchNodes(nodesService: NodesService, user: User, nodeId?: string) {
  const dockerViewScopes = [
    'docker:containers:view',
    'docker:images:view',
    'docker:volumes:view',
    'docker:networks:view',
  ];
  if (nodeId) {
    if (
      !dockerViewScopes.some(
        (scope) =>
          hasScopeForResource(user.scopes, scope, nodeId) || dockerScopedNodeIds(user.scopes, [scope]).includes(nodeId)
      )
    ) {
      return [];
    }
    const node = await nodesService.get(nodeId);
    return node.type === 'docker' ? [{ id: node.id, slug: node.slug }] : [];
  }
  const broadAccess = dockerViewScopes.some((scope) => hasScope(user.scopes, scope));
  const scopedIds = broadAccess ? undefined : dockerScopedNodeIds(user.scopes, dockerViewScopes);
  if (scopedIds?.length === 0) return [];
  const dockerNodes: Array<{ id: string; slug: string }> = [];
  let page = 1;
  let totalPages = 1;
  do {
    const nodes = await nodesService.list(
      { type: 'docker', page, limit: 100 },
      scopedIds ? { allowedIds: scopedIds } : undefined
    );
    dockerNodes.push(...nodes.data.map((node) => ({ id: node.id, slug: node.slug })));
    totalPages = nodes.totalPages;
    page += 1;
  } while (page <= totalPages);
  return dockerNodes;
}
