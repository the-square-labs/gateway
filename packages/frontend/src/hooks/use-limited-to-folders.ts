import { useAuthStore } from "@/stores/auth";

/**
 * Whether the caller sees a resource list only through grants on some of its resources or folders
 * (no broad view scope). Such a caller limited to one folder sees that folder on its own
 * (`applySingleFolderView`). `null` means the list has no folder grants.
 */
export function useLimitedToFolders(viewScope: string | null): boolean {
  return useAuthStore(
    (state) => !!viewScope && !state.hasScope(viewScope) && state.hasScopedAccess(viewScope)
  );
}
