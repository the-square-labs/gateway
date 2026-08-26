import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild, DockerSourceBinding, DockerSourceTarget } from "@/types";
import { DockerBuildHistoryPanel } from "./DockerBuildHistoryPanel";
import { DockerGitSourcePanel } from "./DockerGitSourcePanel";

interface DockerResourceGitTabsProps {
  target: DockerSourceTarget;
  view: "source" | "builds";
  includeBuilds?: boolean;
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
  canEdit?: boolean;
  canBuild?: boolean;
}

const ACTIVE_BUILD_STATUSES = new Set<DockerBuild["status"]>([
  "queued",
  "claimed",
  "checking_out",
  "building",
  "scanning",
  "pushing",
  "deploying",
]);

export function DockerResourceGitTabs({
  target,
  view,
  includeBuilds = false,
  composeVariables,
  composeSecretKeys,
  canEdit = true,
  canBuild = true,
}: DockerResourceGitTabsProps) {
  const [source, setSource] = useState<DockerSourceBinding | null>(null);
  const [builds, setBuilds] = useState<DockerBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sourceRequestId = useRef(0);
  const buildRequestId = useRef(0);
  const targetKind = target.kind;
  const targetNodeId = target.nodeId;
  const targetResourceId =
    target.kind === "container"
      ? target.containerName
      : target.kind === "deployment"
        ? target.deploymentId
        : target.kind === "compose_project"
          ? target.composeProjectId
          : target.pageProjectId;
  const stableTarget = useMemo<DockerSourceTarget>(
    () =>
      targetKind === "container"
        ? { kind: "container", nodeId: targetNodeId!, containerName: targetResourceId }
        : targetKind === "deployment"
          ? { kind: "deployment", nodeId: targetNodeId, deploymentId: targetResourceId }
          : targetKind === "compose_project"
            ? { kind: "compose_project", nodeId: targetNodeId!, composeProjectId: targetResourceId }
            : { kind: "pages_project", nodeId: targetNodeId, pageProjectId: targetResourceId },
    [targetKind, targetNodeId, targetResourceId]
  );

  const load = useCallback(async () => {
    const currentRequest = ++sourceRequestId.current;
    setLoading(true);
    setError(null);
    try {
      const nextSource = await api.getDockerSource(stableTarget);
      const nextBuilds =
        (view === "builds" || includeBuilds) && nextSource
          ? await api.listDockerBuilds({ sourceBindingId: nextSource.id, limit: 5 })
          : [];
      if (currentRequest !== sourceRequestId.current) return;
      setSource(nextSource);
      if (view === "builds" || includeBuilds) setBuilds(nextBuilds);
    } catch (error) {
      if (currentRequest !== sourceRequestId.current) return;
      const message = error instanceof Error ? error.message : "Failed to load repository state";
      setError(message);
      toast.error(message);
    } finally {
      if (currentRequest === sourceRequestId.current) setLoading(false);
    }
  }, [includeBuilds, stableTarget, view]);

  const refreshBuilds = useCallback(async () => {
    if (!source || (view !== "builds" && !includeBuilds)) return;
    const currentRequest = ++buildRequestId.current;
    try {
      const nextBuilds = await api.listDockerBuilds({ sourceBindingId: source.id, limit: 5 });
      if (currentRequest === buildRequestId.current) setBuilds(nextBuilds);
    } catch {
      // Background polling remains silent; the existing rows stay visible.
    }
  }, [includeBuilds, source, view]);

  useEffect(() => {
    void load();
    return () => {
      sourceRequestId.current += 1;
      buildRequestId.current += 1;
    };
  }, [load]);

  const hasActiveBuilds = builds.some((build) => ACTIVE_BUILD_STATUSES.has(build.status));
  useRealtime(
    source ? "docker.build.changed" : null,
    (payload) => {
      const event = payload as { sourceBindingId?: string } | undefined;
      if (event?.sourceBindingId === source?.id) void refreshBuilds();
    },
    { onReconnect: () => void refreshBuilds() }
  );
  useRealtime(source ? "docker.build.artifact.changed" : null, (payload) => {
    const event = payload as { sourceBindingId?: string } | undefined;
    if (!event?.sourceBindingId || event.sourceBindingId === source?.id) void refreshBuilds();
  });

  useEffect(() => {
    if (!source || (view !== "builds" && !includeBuilds)) return;
    const interval = window.setInterval(
      () => {
        if (!document.hidden) void refreshBuilds();
      },
      hasActiveBuilds ? 5_000 : 15_000
    );
    return () => window.clearInterval(interval);
  }, [hasActiveBuilds, includeBuilds, refreshBuilds, source, view]);

  return view === "source" ? (
    <div className="space-y-4">
      <DockerGitSourcePanel
        target={stableTarget}
        source={source}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        onBuildQueued={includeBuilds ? () => void refreshBuilds() : undefined}
        onSourceChange={setSource}
        composeVariables={composeVariables}
        composeSecretKeys={composeSecretKeys}
        canEdit={canEdit}
        canBuild={canBuild}
      />
      {includeBuilds && source ? (
        <DockerBuildHistoryPanel builds={builds} sourceBindingId={source.id} loading={loading} />
      ) : null}
    </div>
  ) : (
    <DockerBuildHistoryPanel builds={builds} sourceBindingId={source?.id} loading={loading} />
  );
}
