import { GitBranch, Hammer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { DockerContainerDetail } from "../DockerContainerDetail";
import { DockerResourceGitTabs } from "./DockerResourceGitTabs";
import type { InspectData } from "./helpers";

export async function resolveContainerOrPendingSource(
  nodeId: string,
  containerName: string
): Promise<InspectData> {
  try {
    return (await api.inspectContainerByName(nodeId, containerName)) as InspectData;
  } catch (error) {
    // A dedicated scoped endpoint proves a persisted reservation. Runtime
    // inspection itself must never invent a container for mutation callers.
    const pending = await api
      .getPendingDockerSourceContainer(nodeId, containerName)
      .catch(() => null);
    if (!pending?.pendingSourceBuild) throw error;
    return { ...pending, Id: pending.sourceBindingId, Name: `/${pending.containerName}` };
  }
}

/** A persisted source reservation, not a Docker runtime or an HA placement. */
export function DockerPendingContainerDetail({
  nodeId,
  nodeSlug,
  containerName,
  snapshot,
  pageContextToken,
}: {
  nodeId: string;
  nodeSlug: string;
  containerName: string;
  snapshot: InspectData;
  pageContextToken?: number | null;
}) {
  const navigate = useStableNavigate();
  const [runtime, setRuntime] = useState<InspectData | null>(null);
  const [pending, setPending] = useState(snapshot);
  const { hasScope } = useAuthStore();
  const resourceScope = `${nodeId}/${snapshot.scopeResourceId}`;
  const canEdit = hasScope(`docker:containers:edit:${resourceScope}`);
  const canBuild = hasScope(`docker:containers:manage:${resourceScope}`);
  const [tab, setTab] = useUrlTab(["source", "builds"], "source", (next) =>
    dockerContainerRoute(nodeSlug, containerName, next)
  );
  const refresh = useCallback(async () => {
    try {
      const next = (await api.inspectContainerByName(nodeId, containerName, true)) as InspectData;
      if (!next.pendingSourceBuild) setRuntime(next);
    } catch {
      // Initial build failures leave Source and its failed-build history usable.
      const next = await api
        .getPendingDockerSourceContainer(nodeId, containerName)
        .catch(() => null);
      if (next) setPending(next);
    }
  }, [nodeId, containerName]);
  useEffect(() => {
    if (runtime) return;
    let active = true;
    const timer = setInterval(() => {
      if (active && !document.hidden) void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh, runtime]);
  useRealtime(
    runtime ? null : "docker.build.changed",
    (payload) => {
      if ((payload as { sourceBindingId?: string })?.sourceBindingId === snapshot.sourceBindingId)
        void refresh();
    },
    { onReconnect: () => void refresh() }
  );

  if (runtime)
    return (
      <DockerContainerDetail
        resolvedNodeId={nodeId}
        resolvedNodeSlug={nodeSlug}
        resolvedContainerName={containerName}
        resolvedContainerId={String(runtime.Id ?? runtime.id)}
        resolvedContainer={runtime}
        pageContextToken={pageContextToken}
      />
    );

  return (
    <PageTransition>
      <div className="h-full p-6 flex flex-col gap-4 overflow-y-auto">
        <div className="flex shrink-0 items-center gap-3">
          <PageBackButton onClick={() => navigate("/docker/containers")} />
          <h1 className="min-w-0 truncate text-2xl font-bold">{containerName}</h1>
          <Badge
            variant={pending.latestBuild?.status === "failed" ? "warning" : "secondary"}
            size="inline"
            className="shrink-0"
          >
            {pending.latestBuild?.status === "failed" ? "Build failed" : "Awaiting deployment"}
          </Badge>
        </div>
        <PanelShell
          title="Resource created"
          description="The container will be created by the first successful deployment. You can edit the security policy in Source and retry failed or blocked builds. Runtime actions become available after deployment."
        />
        <Tabs value={tab} onValueChange={setTab} className="min-w-0">
          <TabsList>
            <TabsTrigger value="source">
              <GitBranch className="h-4 w-4" />
              Source
            </TabsTrigger>
            <TabsTrigger value="builds">
              <Hammer className="h-4 w-4" />
              Builds
            </TabsTrigger>
          </TabsList>
          <TabsContent value="source">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId, containerName }}
              view="source"
              canEdit={canEdit}
              canBuild={canBuild}
            />
          </TabsContent>
          <TabsContent value="builds">
            <DockerResourceGitTabs
              target={{ kind: "container", nodeId, containerName }}
              view="builds"
              canEdit={canEdit}
              canBuild={canBuild}
            />
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
