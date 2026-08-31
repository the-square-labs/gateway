import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild, DockerBuildLogChunk, DockerBuildStatus } from "@/types";
import { DockerLogViewport } from "./DockerLogViewport";

const STATUS_VARIANT: Record<
  DockerBuildStatus,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  queued: "secondary",
  claimed: "secondary",
  checking_out: "default",
  building: "default",
  scanning: "default",
  pushing: "default",
  deploying: "warning",
  succeeded: "success",
  failed: "destructive",
  cancelled: "secondary",
  superseded: "secondary",
};

const VULNERABILITY_VARIANT: Record<string, "secondary" | "destructive" | "warning"> = {
  critical: "destructive",
  high: "destructive",
  medium: "warning",
  low: "secondary",
  negligible: "secondary",
  unknown: "secondary",
};

function MetaRow({
  label,
  children,
  header = false,
}: {
  label: string;
  children: ReactNode;
  header?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-center justify-between gap-4 px-4 py-3 ${
        header ? "bg-muted/40" : ""
      }`}
    >
      <span
        className={`shrink-0 text-sm ${
          header ? "font-medium text-foreground" : "text-muted-foreground"
        }`}
      >
        {label}
      </span>
      <span className="min-w-0 text-right text-sm">{children}</span>
    </div>
  );
}

interface DockerBuildDetailsDialogProps {
  open: boolean;
  build: DockerBuild | null;
  onOpenChange: (open: boolean) => void;
  onExited: () => void;
}

export function DockerBuildDetailsDialog({
  open,
  build,
  onOpenChange,
  onExited,
}: DockerBuildDetailsDialogProps) {
  const [logs, setLogs] = useState<DockerBuildLogChunk[]>([]);
  const logRequestId = useRef(0);
  const buildId = build?.id ?? null;
  const refreshLogs = useCallback(async () => {
    if (!buildId) return;
    const requestId = ++logRequestId.current;
    try {
      const next = await api.getDockerBuildLogs(buildId);
      if (requestId === logRequestId.current) setLogs(next);
    } catch {
      // Keep the current log output until a realtime refresh succeeds.
    }
  }, [buildId]);

  useEffect(() => {
    if (!open || !buildId) return;
    setLogs([]);
    void refreshLogs();
    return () => {
      logRequestId.current += 1;
    };
  }, [buildId, open, refreshLogs]);

  useRealtime(open && buildId ? "docker.build.log" : null, (payload) => {
    const event = payload as { buildId?: string } | undefined;
    if (event?.buildId === buildId) void refreshLogs();
  });

  const scanSummary = build?.artifact?.scanSummary ?? null;
  const vulnerabilities = scanSummary?.vulnerabilities ?? [];
  const vulnerabilityCounts = scanSummary
    ? (["critical", "high", "medium", "low", "unknown"] as const).filter(
        (severity) => scanSummary[severity] > 0
      )
    : [];
  const vulnerabilityTotal = scanSummary
    ? scanSummary.critical +
      scanSummary.high +
      scanSummary.medium +
      scanSummary.low +
      scanSummary.unknown
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            onExited();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Build details</DialogTitle>
          <DialogDescription>{build?.repositoryFullPath}</DialogDescription>
        </DialogHeader>
        {build && (
          <div className="divide-y divide-border overflow-hidden border border-border bg-card">
            <MetaRow label="Status" header>
              <Badge variant={STATUS_VARIANT[build.status]}>
                {build.status.replaceAll("_", " ")}
              </Badge>
            </MetaRow>
            <MetaRow label="Commit">
              <span className="break-all font-mono text-xs">{build.commitSha}</span>
            </MetaRow>
            {build.serviceName && <MetaRow label="Compose service">{build.serviceName}</MetaRow>}
            <MetaRow label="Platform">{build.platform ?? "Not assigned"}</MetaRow>
            <MetaRow label="Build Worker">
              <Badge variant="secondary">
                {build.builderName ?? build.builderNodeId ?? "Waiting"}
              </Badge>
            </MetaRow>
            {build.errorMessage && (
              <MetaRow label="Error">
                <span className="break-words text-red-600 dark:text-red-400">
                  {build.errorMessage}
                </span>
              </MetaRow>
            )}
          </div>
        )}
        {scanSummary && vulnerabilityTotal > 0 && (
          <PanelShell
            title="Vulnerabilities"
            description={`${vulnerabilityTotal} detected by ${scanSummary.scanner || "the image scanner"}`}
            actions={
              <div className="flex flex-wrap justify-end gap-1">
                {vulnerabilityCounts.map((severity) => (
                  <Badge key={severity} variant={VULNERABILITY_VARIANT[severity]} size="inline">
                    {scanSummary[severity]} {severity}
                  </Badge>
                ))}
              </div>
            }
            bodyClassName="divide-y divide-border"
          >
            {vulnerabilities.length > 0 ? (
              vulnerabilities.map((vulnerability, index) => (
                <div
                  key={`${vulnerability.id}:${vulnerability.packageName}:${index}`}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs font-medium">{vulnerability.id}</div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {vulnerability.packageName || "Unknown package"}
                      {vulnerability.installedVersion ? ` @ ${vulnerability.installedVersion}` : ""}
                      {vulnerability.packageType ? ` · ${vulnerability.packageType}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {vulnerability.fixedVersions.length > 0
                        ? `Fixed in ${vulnerability.fixedVersions.join(", ")}`
                        : vulnerability.fixState || "No fix reported"}
                    </p>
                  </div>
                  <Badge
                    variant={
                      VULNERABILITY_VARIANT[vulnerability.severity.toLowerCase()] ?? "secondary"
                    }
                    size="inline"
                  >
                    {vulnerability.severity}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                Detailed findings were not retained for this build.
              </div>
            )}
            {(scanSummary.vulnerabilitiesTruncated ?? 0) > 0 && (
              <div className="px-4 py-3 text-xs text-muted-foreground">
                {scanSummary.vulnerabilitiesTruncated} additional findings are omitted from this
                view.
              </div>
            )}
          </PanelShell>
        )}
        {build && (
          <DockerLogViewport
            key={build.id}
            lines={logs}
            keyFn={(line) => line.sequence}
            renderContent={(line) => line.content}
            emptyState={
              <div className="px-4 text-xs text-muted-foreground">No build log output yet.</div>
            }
            bordered
            className="h-72"
            initialScrollToEnd
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
