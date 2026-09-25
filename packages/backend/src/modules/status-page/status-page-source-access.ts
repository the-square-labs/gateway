import { hasScope } from '@/lib/permissions.js';
import { hasDockerResourceScope } from '@/modules/docker/docker-access-resource.service.js';

export type StatusPageSourceType =
  | 'node'
  | 'proxy_host'
  | 'database'
  | 'docker_container'
  | 'docker_deployment'
  | 'docker_compose_project'
  | 'pages_project';

/**
 * The resource behind a status page service, resolved to the identity its scopes use.
 * Docker sources are node-scoped: `nodeId` plus the resource id inside the node
 * (a container's access resource id, the deployment id or the Compose project id).
 */
export interface StatusPageSourceIdentity {
  sourceType: StatusPageSourceType;
  sourceId: string;
  nodeId?: string | null;
  scopeResourceId?: string | null;
}

/**
 * A status page manager may only expose (or edit the public listing of) a resource they can see:
 * publishing a resource's health is a read of that resource. Uses the same view scope as the
 * resource's own list and detail routes, so folder and node grants count.
 */
export function canViewStatusPageSource(scopes: readonly string[], source: StatusPageSourceIdentity): boolean {
  const granted = [...scopes];
  switch (source.sourceType) {
    case 'node':
      return hasScope(granted, `nodes:details:${source.sourceId}`);
    case 'proxy_host':
      return hasScope(granted, `proxy:view:${source.sourceId}`);
    case 'database':
      return hasScope(granted, `databases:view:${source.sourceId}`);
    case 'pages_project':
      return hasScope(granted, `pages:view:${source.sourceId}`);
    case 'docker_container':
      return (
        !!source.nodeId &&
        hasDockerResourceScope(granted, 'docker:containers:view', source.nodeId, source.scopeResourceId ?? '')
      );
    case 'docker_deployment':
      return (
        !!source.nodeId &&
        hasDockerResourceScope(
          granted,
          'docker:containers:view',
          source.nodeId,
          source.scopeResourceId ?? source.sourceId
        )
      );
    case 'docker_compose_project':
      return (
        !!source.nodeId &&
        hasDockerResourceScope(granted, 'docker:compose:view', source.nodeId, source.scopeResourceId ?? source.sourceId)
      );
    default:
      return false;
  }
}
