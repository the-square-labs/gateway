import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/services/api";
import type { DockerSourceBinding, DockerSourceTarget } from "@/types";
import { DockerBuildHistoryPanel } from "./DockerBuildHistoryPanel";
import { DockerGitSourcePanel } from "./DockerGitSourcePanel";

interface DockerResourceGitTabsProps {
  target: DockerSourceTarget;
  view: "source" | "builds";
  composeVariables?: Record<string, string>;
  composeSecretKeys?: string[];
  canEdit?: boolean;
  canBuild?: boolean;
  pendingContainer?: boolean;
}

export function DockerResourceGitTabs({
  target,
  view,
  composeVariables,
  composeSecretKeys,
  canEdit = true,
  canBuild = true,
  pendingContainer = false,
}: DockerResourceGitTabsProps) {
  const [source, setSource] = useState<DockerSourceBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sourceRequestId = useRef(0);
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
      if (currentRequest !== sourceRequestId.current) return;
      setSource(nextSource);
    } catch (error) {
      if (currentRequest !== sourceRequestId.current) return;
      const message = error instanceof Error ? error.message : "Failed to load repository state";
      setError(message);
      toast.error(message);
    } finally {
      if (currentRequest === sourceRequestId.current) setLoading(false);
    }
  }, [stableTarget]);

  useEffect(() => {
    void load();
    return () => {
      sourceRequestId.current += 1;
    };
  }, [load]);

  return view === "source" ? (
    <DockerGitSourcePanel
      target={stableTarget}
      source={source}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      onSourceChange={setSource}
      composeVariables={composeVariables}
      composeSecretKeys={composeSecretKeys}
      canEdit={canEdit}
      canBuild={canBuild}
      pendingContainer={pendingContainer}
    />
  ) : (
    <DockerBuildHistoryPanel
      key={source?.id ?? "loading"}
      sourceBindingId={source?.id}
      loading={loading}
    />
  );
}
