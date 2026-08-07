import type { DashboardAttentionSeverity } from "@/types";

export function dashboardAttentionLabel(severity: DashboardAttentionSeverity): string {
  if (severity === "critical") return "Dashboard has a critical system issue";
  if (severity === "warning") return "Dashboard requires attention";
  return "Dashboard has setup information";
}

export function dashboardAttentionDotClass(severity: DashboardAttentionSeverity): string {
  if (severity === "critical") return "bg-destructive";
  if (severity === "warning") return "bg-warning";
  return "bg-[color:var(--color-link)]";
}
