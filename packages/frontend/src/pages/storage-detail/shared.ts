import { formatBytes } from "@/lib/utils";
import type { ObjectStorageConnection } from "@/types";

export const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

export const METRIC_COLORS: Record<string, string> = {
  latency_ms: "#f97316",
  bucket_count: "#2563eb",
  cpu_pct: "#8b5cf6",
  memory_used_bytes: "#10b981",
  disk_used_bytes: "#0ea5e9",
  swap_used_bytes: "#f59e0b",
  network_rx_bytes: "#06b6d4",
  network_tx_bytes: "#ec4899",
};

export const PROVIDER_LABELS: Record<ObjectStorageConnection["provider"], string> = {
  aws: "AWS S3",
  cloudflare_r2: "Cloudflare R2",
  minio: "MinIO",
  other: "S3-compatible",
  ftp: "FTP",
  ftps: "FTPS",
  sftp: "SFTP",
};

export function formatMetricValue(key: string, value: number | null): string {
  if (value == null) return "-";
  if (key.includes("bytes")) return formatBytes(value);
  if (key.endsWith("_pct")) return `${value.toFixed(1)}%`;
  if (key.endsWith("_ms")) return `${value.toFixed(0)} ms`;
  return `${value}`;
}

export function formatHealthStatusLabel(
  status: ObjectStorageConnection["healthStatus"] | "unknown"
): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatProviderLabel(provider: ObjectStorageConnection["provider"]): string {
  return PROVIDER_LABELS[provider] ?? provider;
}
