import { useCallback } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { PopoutTerminal } from "@/components/terminal/PopoutTerminal";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

export function DockerConsolePopout() {
  const { nodeId, containerId } = useParams<{ nodeId: string; containerId: string }>();
  const [searchParams] = useSearchParams();
  const { hasScopedAccess } = useAuthStore();
  const shell = searchParams.get("shell") || "auto";

  const wsFactory = useCallback(
    () => api.createExecWebSocket(nodeId!, containerId!, shell),
    [nodeId, containerId, shell]
  );

  if (!nodeId || !containerId) return null;
  if (!hasScopedAccess("docker:containers:console")) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        You don't have permission to access the container console.
      </div>
    );
  }

  return (
    <PopoutTerminal
      wsFactory={wsFactory}
      channelKey={`docker-console:${containerId}`}
      title={`Console — ${containerId.slice(0, 12)}`}
    />
  );
}
