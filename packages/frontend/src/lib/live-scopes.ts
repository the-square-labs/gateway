import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

const DYNAMIC_GRANT = /:(folder|node)\//;

/**
 * Folder and node grants resolve to concrete resource ids on the server at request time, so a
 * resource a colleague just created in a granted folder is in a fresh list before the cached
 * scopes know it. Lists call this on refresh so row actions and detail pages catch up without a
 * reload. Callers with only broad or per-resource grants skip the request.
 */
export async function refreshDynamicScopes(): Promise<void> {
  const auth = useAuthStore.getState();
  if (!auth.user?.scopes.some((scope) => DYNAMIC_GRANT.test(scope))) return;
  try {
    const user = await api.getCurrentUser();
    useAuthStore.getState().applyLiveScopes(user.scopes);
  } catch {
    // The list itself is already server-filtered; a failed refresh only delays row actions.
  }
}
