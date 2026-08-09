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
export function getDomainPermissions(hasScope: (scope: string) => boolean): DomainPermissions {
  return {
    canCreateDomain: hasScope("domains:create"),
    canEditDomain: hasScope("domains:edit"),
    canDeleteDomain: hasScope("domains:delete"),
    canInspectCloudflare:
      hasScope("integrations:cloudflare:view") ||
      hasScope("integrations:cloudflare:dns:view") ||
      hasScope("integrations:cloudflare:dns:edit") ||
      hasScope("integrations:cloudflare:dns:delete") ||
      hasScope("integrations:cloudflare:manage"),
  };
}
