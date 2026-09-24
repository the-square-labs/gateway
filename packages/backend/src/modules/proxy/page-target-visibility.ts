import { hasScope } from '@/lib/permissions.js';

type ProxyHostLike = Record<string, unknown>;

export function redactPageTargetWithoutProjectAccess<T extends ProxyHostLike>(host: T, scopes: string[]): T {
  const target = host.pageTarget as { projectId?: unknown } | null | undefined;
  if (!target || typeof target.projectId !== 'string' || hasScope(scopes, `pages:view:${target.projectId}`)) {
    return host;
  }
  return { ...host, pageTarget: null };
}

/** Advanced config is gated behind proxy:advanced:<id>, like the template preview. */
export function redactAdvancedConfigWithoutScope<T extends ProxyHostLike>(host: T, scopes: string[]): T {
  if (host.advancedConfig === null || host.advancedConfig === undefined) return host;
  const id = host.id;
  if (typeof id === 'string' && hasScope(scopes, `proxy:advanced:${id}`)) return host;
  return { ...host, advancedConfig: null };
}

/** Scope-based redaction shared by every proxy host view/list response. */
export function redactProxyHostForScopes<T extends ProxyHostLike>(host: T, scopes: string[]): T {
  return redactAdvancedConfigWithoutScope(redactPageTargetWithoutProjectAccess(host, scopes), scopes);
}

/** Additional Route view: advanced config needs proxy:advanced:<host>, Pages fields need pages:view:<project>. */
export function redactAdditionalRouteForScopes(route: Record<string, unknown>, scopes: string[]) {
  const hostId = typeof route.proxyHostId === 'string' ? route.proxyHostId : null;
  const visibleRoute =
    hostId && hasScope(scopes, `proxy:advanced:${hostId}`) ? route : { ...route, advancedConfig: null };
  if (route.targetKind !== 'pages') return visibleRoute;
  const projectId = typeof route.pageProjectId === 'string' ? route.pageProjectId : null;
  if (!projectId || !hasScope(scopes, `pages:view:${projectId}`)) {
    return {
      ...visibleRoute,
      pageProjectId: null,
      pageTagId: null,
      activeDeploymentId: null,
      includePath: null,
      runtimeConfigPath: null,
      runtimeConfigGeneration: 0,
      pageProjectName: null,
      pageProjectSlug: null,
      pageProjectAppearanceColor: null,
      pageTagName: null,
    };
  }
  return visibleRoute;
}

export function redactGroupedPageTargets<T extends { folders: unknown[]; ungroupedHosts: ProxyHostLike[] }>(
  result: T,
  scopes: string[]
): T {
  const redactFolder = (folder: any): any => ({
    ...folder,
    hosts: (folder.hosts ?? []).map((host: ProxyHostLike) => redactProxyHostForScopes(host, scopes)),
    children: (folder.children ?? []).map(redactFolder),
  });

  return {
    ...result,
    folders: result.folders.map(redactFolder),
    ungroupedHosts: result.ungroupedHosts.map((host) => redactProxyHostForScopes(host, scopes)),
  };
}

export function redactFolderTreeProxyHostsForScopes<T extends unknown[]>(tree: T, scopes: string[]): T {
  const redactFolder = (folder: any): any => ({
    ...folder,
    hosts: (folder.hosts ?? []).map((host: ProxyHostLike) => redactProxyHostForScopes(host, scopes)),
    children: (folder.children ?? []).map(redactFolder),
  });
  return tree.map(redactFolder) as T;
}
