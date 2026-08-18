import type { PageDeploymentStatus } from "@/types";

export function formatPageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatPageDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function pageStatusVariant(status: PageDeploymentStatus | string) {
  if (status === "ready") return "success" as const;
  if (status === "failed" || status === "deleted") return "destructive" as const;
  if (status === "uploading" || status === "validating" || status === "staging") {
    return "warning" as const;
  }
  return "secondary" as const;
}

export function pageStatusLabel(status: PageDeploymentStatus | string): string {
  return status.replaceAll("_", " ");
}

export function pagePreviewUrl(hostname: string | null): string | null {
  if (!hostname) return null;
  return `${window.location.protocol}//${hostname}`;
}

export function nodeSupportsPages(
  node: { capabilities?: Record<string, unknown> } | null
): boolean {
  const capabilities = node?.capabilities;
  if (!capabilities) return false;
  const advertised = capabilities.capabilities;
  const hasCapability = (name: string) =>
    capabilities[name] === true || (Array.isArray(advertised) && advertised.includes(name));
  return hasCapability("nginx_pages_v1") && hasCapability("nginx_pages_config_v1");
}
