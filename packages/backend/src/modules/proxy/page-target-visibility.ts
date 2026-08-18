import { hasScope } from '@/lib/permissions.js';

type ProxyHostLike = Record<string, unknown>;

export function redactPageTargetWithoutProjectAccess<T extends ProxyHostLike>(host: T, scopes: string[]): T {
  const target = host.pageTarget as { projectId?: unknown } | null | undefined;
  if (!target || typeof target.projectId !== 'string' || hasScope(scopes, `pages:view:${target.projectId}`)) {
    return host;
  }
  return { ...host, pageTarget: null };
}

export function redactGroupedPageTargets<T extends { folders: unknown[]; ungroupedHosts: ProxyHostLike[] }>(
  result: T,
  scopes: string[]
): T {
  const redactFolder = (folder: any): any => ({
    ...folder,
    hosts: (folder.hosts ?? []).map((host: ProxyHostLike) => redactPageTargetWithoutProjectAccess(host, scopes)),
    children: (folder.children ?? []).map(redactFolder),
  });

  return {
    ...result,
    folders: result.folders.map(redactFolder),
    ungroupedHosts: result.ungroupedHosts.map((host) => redactPageTargetWithoutProjectAccess(host, scopes)),
  };
}
