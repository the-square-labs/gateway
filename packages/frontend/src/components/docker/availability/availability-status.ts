const AVAILABILITY_TRANSITION_STATUSES = new Set([
  "enabling",
  "scaling",
  "rolling_out",
  "disabling",
]);

export function isAvailabilityTransition(status?: string | null): boolean {
  return Boolean(status && AVAILABILITY_TRANSITION_STATUSES.has(status));
}

export type AvailabilitySurfaceStatus =
  | "starting"
  | "stopping"
  | "restarting"
  | "rolling_out"
  | "online"
  | "degraded"
  | "offline"
  | "stopped"
  | "failed";

export function resolveAvailabilitySurfaceStatus({
  policyStatus,
  shouldRun,
  serving,
  desired,
  operation,
}: {
  policyStatus?: string | null;
  shouldRun: boolean;
  serving: number;
  desired: number;
  operation?: { type: string; status: string } | null;
}): AvailabilitySurfaceStatus {
  if (operation && ["pending", "running", "waiting"].includes(operation.status)) {
    if (operation.type === "start") return "starting";
    if (operation.type === "stop") return "stopping";
    if (operation.type === "restart") return "restarting";
  }
  if (isAvailabilityTransition(policyStatus)) return "rolling_out";
  if (!shouldRun) return "stopped";
  if (policyStatus === "failed") return "failed";
  if (serving === 0) return "offline";
  if (serving < desired) return "degraded";
  return "online";
}
