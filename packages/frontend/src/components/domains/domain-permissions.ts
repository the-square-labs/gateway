export interface DomainPermissions {
  canCreateDomain: boolean;
  canEditDomain: boolean;
  canDeleteDomain: boolean;
  canInspectCloudflare: boolean;
}

/**
 * Gateway-managed domain actions are authorized exclusively by domains:*
 * scopes. Cloudflare scopes only control whether the UI may inspect connector
 * status; they never enable a domain action.
 */
export function getDomainPermissions(
  hasScope: (scope: string) => boolean,
  domainId?: string | null
): DomainPermissions {
  const grants = (scope: string) =>
    hasScope(scope) || (!!domainId && hasScope(`${scope}:${domainId}`));
  return {
    canCreateDomain: hasScope("domains:create"),
    canEditDomain: grants("domains:edit"),
    canDeleteDomain: grants("domains:delete"),
    canInspectCloudflare:
      hasScope("integrations:cloudflare:view") || hasScope("integrations:cloudflare:manage"),
  };
}
