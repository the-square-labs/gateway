import { api } from "@/services/api";
import type { PageDeployment, PaginatedResponse } from "@/types";

/** A response this recent answers another first load instead of a new request. */
const REUSE_WINDOW_MS = 5_000;

const latest = new Map<
  string,
  { startedAt: number; request: Promise<PaginatedResponse<PageDeployment>> }
>();

/**
 * The newest 100 Deployments of a Project. The project header, the
 * Deployments tab and the Tags tab all need this list when the page opens, and
 * they mount one after another: a request started within the last few seconds
 * serves all of them. `fresh` always starts a new request (realtime refreshes)
 * and becomes the one later loads reuse.
 */
export function loadPageDeployments(
  projectId: string,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<PaginatedResponse<PageDeployment>> {
  const current = latest.get(projectId);
  if (!fresh && current && Date.now() - current.startedAt < REUSE_WINDOW_MS) {
    return current.request;
  }
  const request = api.listPageDeployments(projectId, { page: 1, limit: 100 });
  latest.set(projectId, { startedAt: Date.now(), request });
  request.catch(() => {
    if (latest.get(projectId)?.request === request) latest.delete(projectId);
  });
  return request;
}

/** Forget shared responses (sign-out, account switch, tests). */
export function clearPageDeploymentsCache() {
  latest.clear();
}
