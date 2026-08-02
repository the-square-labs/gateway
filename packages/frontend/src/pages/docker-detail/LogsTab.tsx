import { Download, ExternalLink, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { AnsiText } from "@/components/ui/ansi-text";
import { Button } from "@/components/ui/button";
import { VirtualLogList } from "@/components/ui/virtual-log-list";
import { api } from "@/services/api";

const CHANNEL_PREFIX = "docker-logs:";
const MAX_LOG_LINES = 10000;

function capNewestLogs(logs: string[]): string[] {
  return logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs;
}

function isTerminalLogError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no such container") ||
    lower.includes("not found") ||
    lower.includes("access denied")
  );
}

// Detect if a log line already starts with a timestamp
function hasTimestamp(line: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]/.test(line) || /^\d{2}:\d{2}:\d{2}/.test(line);
}

export interface LogsTabSource {
  channelId: string;
  title: string;
  description: string;
  state?: string;
  downloadFileName: string;
  createWebSocket: (tail: number) => WebSocket;
  getLogs: (params: { tail?: number; timestamps?: boolean }) => Promise<string[]>;
  popoutUrl?: string;
}

type LogsTabProps =
  | {
      source: LogsTabSource;
      nodeId?: never;
      containerId?: never;
      containerState?: never;
      inspectData?: never;
    }
  | {
      source?: never;
      nodeId: string;
      containerId: string;
      containerState?: string;
      inspectData?: Record<string, any>;
    };

export function LogsTab(props: LogsTabProps) {
  const source = useMemo<LogsTabSource>(() => {
    if (props.source) return props.source;
    return {
      channelId: props.containerId,
      title: "Container Logs",
      description:
        props.containerState === "running"
          ? "stdout and stderr output from the container"
          : `Container is ${props.containerState ?? "stopped"} — showing last logs`,
      state: props.containerState,
      downloadFileName: `container-${props.containerId.slice(0, 12)}-logs.txt`,
      createWebSocket: (tail) =>
        api.createLogStreamWebSocket(props.nodeId, props.containerId, tail),
      getLogs: (params) => api.getContainerLogs(props.nodeId, props.containerId, params),
      popoutUrl: `/docker/logs/${props.nodeId}/${props.containerId}`,
    };
  }, [props.containerId, props.containerState, props.nodeId, props.source]);
  const inspectData = props.source ? undefined : props.inspectData;
  const [lines, setLines] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historyPrependVersion, setHistoryPrependVersion] = useState(0);
  const [, setWsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const terminalErrorRef = useRef(false);

  // ── Popout tracking via BroadcastChannel ──
  const [isPopout, setIsPopout] = useState(false);
  const isPopoutRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popoutAliveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_PREFIX + source.channelId);
    channelRef.current = channel;

    const markAlive = () => {
      isPopoutRef.current = true;
      setIsPopout(true);
      if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
      popoutAliveTimer.current = setTimeout(() => {
        isPopoutRef.current = false;
        setIsPopout(false);
      }, 4000);
    };

    channel.onmessage = (evt) => {
      const { type } = evt.data ?? {};
      if (type === "popout-open" || type === "heartbeat" || type === "pong") {
        markAlive();
      }
      if (type === "popout-close") {
        isPopoutRef.current = false;
        setIsPopout(false);
        if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
      }
    };

    channel.postMessage({ type: "ping" });

    return () => {
      channel.close();
      channelRef.current = null;
      if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
    };
  }, [source.channelId]);

  const openPopout = useCallback(() => {
    if (!source.popoutUrl) return;
    window.open(
      source.popoutUrl,
      `logs-${source.channelId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      "width=1000,height=600,menubar=no,toolbar=no"
    );

    // Disconnect our WS
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);

    isPopoutRef.current = true;
    setIsPopout(true);
  }, [source.channelId, source.popoutUrl]);

  const bringBack = useCallback(() => {
    channelRef.current?.postMessage({ type: "request-close" });
    isPopoutRef.current = false;
    setIsPopout(false);
    if (popoutAliveTimer.current) clearTimeout(popoutAliveTimer.current);
  }, []);

  const processLine = useCallback((line: string): string => {
    const dockerTsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/);
    if (dockerTsMatch) {
      const rest = dockerTsMatch[2];
      if (hasTimestamp(rest)) return rest;
      const ts = new Date(dockerTsMatch[1]);
      const time = ts.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      return `${time}  ${rest}`;
    }
    return line;
  }, []);

  const processLogs = useCallback(
    (rawLines: string[]): string[] => rawLines.map(processLine),
    [processLine]
  );

  const connectWs = useCallback(() => {
    // Don't connect if popout is handling logs
    if (isPopoutRef.current) return;

    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnecting(true);
    setWsConnected(false);
    setLines([]);
    setHistoryPrependVersion(0);
    setHasMore(true);
    setLoadingMore(false);
    terminalErrorRef.current = false;

    const ws = source.createWebSocket(200);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "initial") {
          setLines(capNewestLogs(processLogs(msg.lines ?? [])));
          setHasMore(msg.hasMore ?? false);
          setIsConnecting(false);
        } else if (msg.type === "history") {
          const historyLines = processLogs(msg.lines ?? []);
          setLines((prev) => {
            const updated = [...historyLines, ...prev];
            return capNewestLogs(updated);
          });
          if (historyLines.length > 0) {
            setHistoryPrependVersion((version) => version + 1);
          }
          setHasMore(msg.hasMore ?? false);
          setLoadingMore(false);
        } else if (msg.type === "new") {
          setLines((prev) => {
            const updated = [...prev, ...processLogs(msg.lines ?? [])];
            return capNewestLogs(updated);
          });
        } else if (msg.type === "connected") {
          setWsConnected(true);
        } else if (msg.type === "logs_ended") {
          // Stream ended — will auto-reconnect via onclose handler
        } else if (msg.type === "error" || msg.type === "auth_error") {
          const message = msg.message || "Log stream error";
          terminalErrorRef.current = msg.type === "auth_error" || isTerminalLogError(message);
          toast.error(message);
          setWsConnected(false);
          setIsConnecting(false);
          if (terminalErrorRef.current) {
            setHasMore(false);
          }
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!mountedRef.current) return;
      setWsConnected(false);
      if (terminalErrorRef.current) return;
      // Don't auto-reconnect if popout is active — the popout-closes effect handles it
      if (isPopoutRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current && !isPopoutRef.current) connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsConnected(false);
      setIsConnecting(false);
    };
  }, [processLogs, source]);

  const isRunning = source.state === "running";

  // Fetch static logs for stopped/exited containers
  const fetchStaticLogs = useCallback(async () => {
    setIsConnecting(true);
    try {
      const data = await source.getLogs({ tail: 500, timestamps: true });
      setLines(capNewestLogs(processLogs(data ?? [])));
      setHasMore(false);
    } catch {
      /* */
    }
    setIsConnecting(false);
  }, [processLogs, source]);

  // Auto-connect on mount (skip if popout detected)
  // biome-ignore lint/correctness/useExhaustiveDependencies: connect once on mount
  useEffect(() => {
    mountedRef.current = true;
    const connectTimeout = setTimeout(() => {
      if (mountedRef.current && !isPopoutRef.current) {
        if (isRunning) {
          connectWs();
        } else {
          fetchStaticLogs();
        }
      }
    }, 200);
    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimeout);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // If popout opens after we already connected, disconnect
  useEffect(() => {
    if (isPopout && wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    }
  }, [isPopout]);

  // If popout closes, reconnect (wasPopout prevents firing on initial mount)
  const wasPopout = useRef(false);
  useEffect(() => {
    if (isPopout) {
      wasPopout.current = true;
    } else if (wasPopout.current) {
      wasPopout.current = false;
      connectWs();
    }
  }, [isPopout, connectWs]);

  // Scroll handler: detect scroll to top for loading more, and track user scroll position
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  // Keep refs in sync with state
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const requestMoreLines = useCallback(() => {
    if (!hasMoreRef.current || loadingMoreRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    wsRef.current.send(JSON.stringify({ type: "load_more" }));
  }, []);

  const downloadLogs = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = source.downloadFileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Popout active: show placeholder ──
  if (isPopout) {
    return (
      <PanelShell className="flex flex-1 flex-col min-h-0" bodyClassName="flex flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <ScrollText className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Logs are open in a separate window</p>
          <Button variant="outline" size="sm" onClick={bringBack}>
            Bring back here
          </Button>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title={source.title}
      description={source.description}
      className="flex flex-1 flex-col min-h-0"
      bodyClassName="flex min-h-0 flex-1 flex-col"
      actions={
        <>
          {lines.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={downloadLogs}
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {source.popoutUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={openPopout}
              title="Open in separate window"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      }
    >
      <VirtualLogList
        lines={lines}
        keyFn={(_, i) => i}
        prependVersion={historyPrependVersion}
        renderLine={(line) => (
          <div className="whitespace-pre-wrap break-all leading-5 px-4 font-mono text-xs text-foreground/80">
            <AnsiText text={line as string} />
          </div>
        )}
        onLoadMore={requestMoreLines}
        hasMore={hasMore}
        loadingMore={loadingMore}
        className="flex-1 min-h-0 overflow-auto bg-card py-4"
        emptyState={
          <div className="px-4 font-mono text-xs text-foreground/80">
            {isConnecting ? (
              <span className="text-muted-foreground">Connecting to log stream...</span>
            ) : (
              <div className="text-muted-foreground space-y-2">
                <div>No logs available</div>
                {!isRunning && inspectData?.State && (
                  <div className="space-y-1 mt-4 text-xs">
                    <div>
                      Exit Code:{" "}
                      <span
                        className={
                          inspectData.State.ExitCode === 0 ? "text-foreground" : "text-red-400"
                        }
                      >
                        {inspectData.State.ExitCode ?? "unknown"}
                      </span>
                    </div>
                    {inspectData.State.Error && (
                      <div>
                        Error: <span className="text-red-400">{inspectData.State.Error}</span>
                      </div>
                    )}
                    {inspectData.State.OOMKilled && (
                      <div className="text-red-400">
                        Container was killed by OOM (out of memory)
                      </div>
                    )}
                    {inspectData.State.FinishedAt && (
                      <div>Finished: {new Date(inspectData.State.FinishedAt).toLocaleString()}</div>
                    )}
                    {inspectData.Config?.Cmd && (
                      <div>
                        CMD:{" "}
                        <span className="text-foreground/70">
                          {JSON.stringify(inspectData.Config.Cmd)}
                        </span>
                      </div>
                    )}
                    {inspectData.Config?.Entrypoint && (
                      <div>
                        Entrypoint:{" "}
                        <span className="text-foreground/70">
                          {JSON.stringify(inspectData.Config.Entrypoint)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        }
      />
    </PanelShell>
  );
}
