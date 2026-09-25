import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";

/** Mirrors the backend `LOGGING_VIEW_SCOPE_BASES`: any resource or folder variant counts. */
const LOGGING_VIEW_SCOPE_BASES = [
  "logs:environments:view",
  "logs:schemas:view",
  "logs:tokens:view",
  "logs:read",
] as const;

/**
 * Same rule as the backend `hasLoggingHealthAccess`: the logging storage health snapshot
 * is shown to anyone who works with logging, or to housekeeping viewers.
 */
export function canViewLoggingHealth(scopes: readonly string[]): boolean {
  return (
    scopeMatches(scopes, "housekeeping:view") ||
    LOGGING_VIEW_SCOPE_BASES.some((base) => hasScopeBase(scopes, base))
  );
}
