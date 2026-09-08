import { api } from "@/services/api";
import type { HostingActionInput } from "@/types/hosting";
import { createClientUuid } from "./client-id";

/** Dispatch an explicit confirmation. Execution and resource status belong to the backend. */
export function performHostingAction(
  resourceId: string,
  request: Omit<HostingActionInput, "idempotencyKey">
) {
  return api.hostingResourceAction(resourceId, {
    ...request,
    idempotencyKey: createClientUuid(),
  });
}
