import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/common/EmptyState";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";

interface NginxLogEntry {
  hostId: string;
  timestamp: string;
  remoteAddr: string;
  method: string;
  path: string;
  status: number;
  bodyBytesSent: string;
  raw: string;
  logType: string;
  level: string;
}

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  "2": "success",
  "3": "default",
  "4": "warning",
  "5": "destructive",
};

const LOG_COLUMNS: ResourceListColumn<NginxLogEntry>[] = [
  { id: "time", label: "Time", width: 140 },
  { id: "type", label: "Type", width: 80 },
  { id: "remoteAddr", label: "Remote Addr", width: 160 },
  { id: "method", label: "Method", width: 90 },
  { id: "path", label: "Path / Message" },
  { id: "status", label: "Status", width: 80 },
  { id: "size", label: "Size", width: 90, align: "right" },
];

const LOAD_MORE_SCROLL_THRESHOLD = 560;

function TruncatedCellText({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn("block min-w-0 max-w-full truncate", className)} title={title}>
      {children}
    </span>
  );
}

function logEntryKey(entry: NginxLogEntry) {
  return [
    entry.logType,
    entry.timestamp,
    entry.remoteAddr,
    entry.method,
    entry.path,
    entry.status,
    entry.bodyBytesSent,
    entry.raw,
    entry.level,
  ].join("\u0000");
}

function logEntryDomKey(entry: NginxLogEntry) {
  let hash = 0;
  const key = logEntryKey(entry);
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

function formatLogTimestamp(timestamp: string) {
  const nginxTimeMatch = timestamp.match(
    /^(\d{1,2})\/([A-Za-z]{3})\/\d{4}:(\d{2}:\d{2}:\d{2})(?:\s|$)/
  );
  if (nginxTimeMatch) return `${nginxTimeMatch[1]}/${nginxTimeMatch[2]} ${nginxTimeMatch[3]}`;

  const isoTimeMatch = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/);
  if (isoTimeMatch) return `${isoTimeMatch[3]}.${isoTimeMatch[2]} ${isoTimeMatch[4]}`;

  return timestamp;
}

function mergeLogEntries(
  current: NginxLogEntry[],
  incoming: NginxLogEntry[],
  mode: "append" | "prepend"
) {
  if (incoming.length === 0) return current;

  const seen = new Set(current.map(logEntryKey));
  const unique = incoming.filter((entry) => {
    const key = logEntryKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return current;

  const next = mode === "prepend" ? [...unique, ...current] : [...current, ...unique];
  return next.length > 10_000 ? next.slice(-10_000) : next;
}

function matchesStatusFilter(entry: NginxLogEntry, statusFilter: string) {
  if (statusFilter === "all") return true;
  if (entry.logType === "error") return statusFilter === "error";
  const prefix = statusFilter.replace("xx", "");
  return String(entry.status).startsWith(prefix);
}

function matchesSearch(entry: NginxLogEntry, search: string) {
  if (!search) return true;
  const q = search.toLowerCase();
  return (
    entry.path?.toLowerCase().includes(q) ||
    entry.remoteAddr?.toLowerCase().includes(q) ||
    entry.raw?.toLowerCase().includes(q)
  );
}

export function LogsTab({ hostId }: { hostId: string }) {
  const [logs, setLogs] = useState<NginxLogEntry[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const {
    open: selectedLogOpen,
    value: selectedLog,
    setValue: setSelectedLog,
    onOpenChange: onSelectedLogOpenChange,
  } = useDeferredDialogState<NginxLogEntry>();
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [prependVersion, setPrependVersion] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const loadingMoreRef = useRef(false);
  const hasMoreRef = useRef(true);
  const mountedRef = useRef(true);
  const prependAnchor = useRef<{ key: string; offsetTop: number } | null>(null);
  const hasLogs = logs.length > 0;

  const visibleLogs = useMemo(
    () =>
      logs.filter(
        (entry) => matchesStatusFilter(entry, statusFilter) && matchesSearch(entry, debouncedSearch)
      ),
    [debouncedSearch, logs, statusFilter]
  );
  const hasVisibleLogs = visibleLogs.length > 0;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const requestMoreLogs = useCallback(() => {
    const el = scrollRef.current;
    const ws = wsRef.current;
    if (!el || !hasMoreRef.current || loadingMoreRef.current) return;
    if (ws?.readyState !== WebSocket.OPEN) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    ws.send(JSON.stringify({ type: "load_more" }));
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolled.current = !atBottom;
      if (el.scrollTop < LOAD_MORE_SCROLL_THRESHOLD) requestMoreLogs();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [requestMoreLogs]);

  useLayoutEffect(() => {
    if (prependVersion === 0) return;
    const el = scrollRef.current;
    const anchor = prependAnchor.current;
    prependAnchor.current = null;
    if (!el || !anchor) return;
    const row = el.querySelector<HTMLElement>(`[data-log-key="${anchor.key}"]`);
    if (!row) return;
    const nextOffsetTop = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTop += nextOffsetTop - anchor.offsetTop;
  }, [prependVersion]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-scroll on new logs
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !userScrolled.current && !prependAnchor.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const capturePrependAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    const scrollerTop = el.getBoundingClientRect().top;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-log-key]"));
    const row =
      rows.find((item) => item.getBoundingClientRect().bottom > scrollerTop) ?? rows[0] ?? null;
    if (!row) return null;
    return {
      key: row.dataset.logKey ?? "",
      offsetTop: row.getBoundingClientRect().top - scrollerTop,
    };
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setStreamError(null);
    setLogs([]);
    setHasMore(true);
    setLoadingMore(false);
    setPrependVersion(0);
    loadingMoreRef.current = false;
    hasMoreRef.current = true;
    userScrolled.current = false;
    prependAnchor.current = null;

    const ws = api.createProxyLogStreamWebSocket(hostId, 200);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(event.data) as {
          type?: string;
          entries?: NginxLogEntry[];
          hasMore?: boolean;
          message?: string;
        };
        if (msg.type === "initial") {
          setLogs(msg.entries ?? []);
          setHasMore(msg.hasMore ?? false);
          setStreamError(null);
          loadingMoreRef.current = false;
          setLoadingMore(false);
        } else if (msg.type === "history") {
          const historyEntries = msg.entries ?? [];
          prependAnchor.current = historyEntries.length > 0 ? capturePrependAnchor() : null;
          setLogs((prev) => mergeLogEntries(prev, historyEntries, "prepend"));
          setHasMore(msg.hasMore ?? false);
          setLoadingMore(false);
          loadingMoreRef.current = false;
          if (historyEntries.length > 0) {
            setPrependVersion((version) => version + 1);
          } else {
            prependAnchor.current = null;
          }
        } else if (msg.type === "new") {
          setLogs((prev) => mergeLogEntries(prev, msg.entries ?? [], "append"));
        } else if (msg.type === "error" || msg.type === "auth_error") {
          setStreamError(msg.message || "Log stream is not available");
          setLoadingMore(false);
          loadingMoreRef.current = false;
        }
      } catch {}
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!mountedRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setStreamError("Log stream is not available");
    };
  }, [capturePrependAnchor, hostId]);

  useEffect(() => {
    mountedRef.current = true;
    const t = setTimeout(() => {
      if (mountedRef.current) connectWs();
    }, 50);
    return () => {
      mountedRef.current = false;
      clearTimeout(t);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWs]);

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
        <Input
          className="flex-1"
          placeholder="Search by path or IP..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="2xx">2xx Success</SelectItem>
            <SelectItem value="3xx">3xx Redirect</SelectItem>
            <SelectItem value="4xx">4xx Client Err</SelectItem>
            <SelectItem value="5xx">5xx Server Err</SelectItem>
            <SelectItem value="error">Error Log</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ResourceListFrame
        minWidth={960}
        className={cn("min-h-0", hasLogs ? "flex-1" : "flex-none")}
        innerClassName={cn("flex flex-col", hasLogs && "h-full")}
      >
        <ResourceListHeaderTable columns={LOG_COLUMNS} />
        <div
          ref={scrollRef}
          className={cn(hasLogs ? "min-h-0 flex-1 overflow-y-auto" : "overflow-visible")}
        >
          <ResourceListTable columns={LOG_COLUMNS} bodyClassName="[&>tr:last-child]:border-b-0">
            {!hasVisibleLogs ? (
              <ResourceListRow className="opacity-100">
                <ResourceListCell colSpan={7} contentClassName="block p-0">
                  <EmptyState
                    message={
                      streamError ??
                      (hasLogs ? "No matching log events" : "Waiting for log events...")
                    }
                    embedded
                  />
                </ResourceListCell>
              </ResourceListRow>
            ) : (
              visibleLogs.map((entry, i) => {
                const isError = entry.logType === "error";
                return (
                  <ResourceListRow
                    key={`${logEntryKey(entry)}:${i}`}
                    data-log-key={logEntryDomKey(entry)}
                    className="opacity-100"
                    interactive
                    onClick={() => setSelectedLog(entry)}
                  >
                    <ResourceListCell contentClassName="text-sm text-muted-foreground">
                      <TruncatedCellText title={entry.timestamp}>
                        {formatLogTimestamp(entry.timestamp)}
                      </TruncatedCellText>
                    </ResourceListCell>
                    <ResourceListCell>
                      <Badge variant={isError ? "destructive" : "secondary"}>
                        {isError ? "err" : "acc"}
                      </Badge>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="text-sm text-muted-foreground">
                      <TruncatedCellText title={isError ? undefined : entry.remoteAddr}>
                        {isError ? "\u2014" : entry.remoteAddr}
                      </TruncatedCellText>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="text-sm">
                      <TruncatedCellText title={isError ? undefined : entry.method}>
                        {isError ? "\u2014" : entry.method}
                      </TruncatedCellText>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="text-sm">
                      <TruncatedCellText title={isError ? entry.raw : entry.path}>
                        {isError ? entry.raw : entry.path}
                      </TruncatedCellText>
                    </ResourceListCell>
                    <ResourceListCell>
                      {isError ? (
                        <Badge variant="destructive">{entry.level || "err"}</Badge>
                      ) : (
                        <Badge variant={STATUS_VARIANT[String(entry.status)[0]] ?? "secondary"}>
                          {entry.status}
                        </Badge>
                      )}
                    </ResourceListCell>
                    <ResourceListCell
                      align="right"
                      contentClassName="text-sm text-muted-foreground"
                    >
                      <TruncatedCellText title={isError ? undefined : entry.bodyBytesSent}>
                        {isError ? "\u2014" : entry.bodyBytesSent}
                      </TruncatedCellText>
                    </ResourceListCell>
                  </ResourceListRow>
                );
              })
            )}
          </ResourceListTable>
        </div>
      </ResourceListFrame>

      <Dialog open={selectedLogOpen} onOpenChange={onSelectedLogOpenChange}>
        <DialogContent className="max-w-full sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Log Details</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">
                {selectedLog ? `${selectedLog.logType || "log"} ${selectedLog.timestamp}` : ""}
              </span>
            </DialogDescription>
          </DialogHeader>
          {selectedLog && (
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 divide-y divide-border overflow-hidden border border-border bg-card">
                {[
                  ["Time", selectedLog.timestamp],
                  ["Type", selectedLog.logType || "-"],
                  ["Remote Addr", selectedLog.logType === "error" ? "-" : selectedLog.remoteAddr],
                  ["Method", selectedLog.logType === "error" ? "-" : selectedLog.method],
                  ["Path", selectedLog.logType === "error" ? "-" : selectedLog.path],
                  [
                    "Status",
                    selectedLog.logType === "error"
                      ? selectedLog.level || "error"
                      : String(selectedLog.status),
                  ],
                  ["Size", selectedLog.logType === "error" ? "-" : selectedLog.bodyBytesSent],
                  ["Raw", selectedLog.raw || "-"],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="grid min-w-0 grid-cols-[minmax(96px,max-content)_minmax(0,1fr)] items-center gap-4 px-4 py-3"
                  >
                    <span className="text-sm text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate text-right font-mono text-sm" title={value}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
