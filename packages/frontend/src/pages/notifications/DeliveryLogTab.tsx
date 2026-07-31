import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import {
  ResourceListCell,
  type ResourceListColumn,
  ResourceListFrame,
  ResourceListHeaderTable,
  ResourceListRow,
  ResourceListTable,
} from "@/components/common/ResourceListLayout";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { WebhookDelivery } from "@/types";

export const DELIVERY_PAGE_SIZE = 100;

const SEV_BADGE: Record<string, "warning" | "destructive" | "secondary"> = {
  info: "secondary",
  warning: "warning",
  critical: "destructive",
};

const STATUS_BADGE: Record<string, "success" | "destructive" | "warning" | "secondary"> = {
  success: "success",
  failed: "destructive",
  retrying: "warning",
  pending: "secondary",
};

const DELIVERY_COLUMNS: ResourceListColumn<WebhookDelivery>[] = [
  { id: "status", label: "", width: "56px" },
  { id: "webhook", label: "Webhook", width: "220px" },
  { id: "event", label: "Event" },
  { id: "severity", label: "Severity", width: "120px" },
  { id: "http", label: "HTTP", width: "96px" },
  { id: "time", label: "Time", width: "96px" },
  { id: "attempt", label: "Attempt", width: "100px" },
  { id: "when", label: "When", width: "180px" },
];

export function DeliveryLogTab({ refreshToken }: { refreshToken: number }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>(
    () => api.getCached<WebhookDelivery[]>("notifications:deliveries:all") ?? []
  );
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<WebhookDelivery[]>("notifications:deliveries:all") === undefined
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const {
    open: detailOpen,
    value: detail,
    setValue: setDetail,
    onOpenChange: onDetailOpenChange,
  } = useDeferredDialogState<WebhookDelivery>();
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const pageRef = useRef(0);
  const requestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(
    async (resetTo: WebhookDelivery[] | null) => {
      const nextPage = resetTo ? 1 : pageRef.current + 1;
      const requestId = ++requestIdRef.current;
      const cacheKey = `notifications:deliveries:${statusFilter}`;
      if (resetTo) {
        const cached = api.getCached<WebhookDelivery[]>(cacheKey);
        if (cached) {
          pageRef.current = 1;
          setDeliveries(cached);
          setIsLoading(false);
          setHasMore(api.getCached<boolean>(`${cacheKey}:has-more`) ?? true);
        } else {
          pageRef.current = 0;
          setDeliveries([]);
          setIsLoading(true);
          setHasMore(true);
        }
      } else {
        setLoadingMore(true);
      }
      try {
        const result = await api.listDeliveries({
          page: nextPage,
          limit: DELIVERY_PAGE_SIZE,
          status: statusFilter !== "all" ? statusFilter : undefined,
        });
        if (requestId !== requestIdRef.current) return;
        const fetched = result.data || [];
        const totalPages = result.totalPages ?? 1;
        pageRef.current = nextPage;
        setDeliveries((prev) => {
          const next = resetTo ? fetched : [...prev, ...fetched];
          if (resetTo) {
            api.setCache(cacheKey, next);
            api.setCache(`${cacheKey}:has-more`, nextPage < totalPages);
          }
          return next;
        });
        setHasMore(nextPage < totalPages);
      } catch {
        toast.error("Failed to load deliveries");
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [statusFilter]
  );

  const openDeliveryDetail = async (delivery: WebhookDelivery) => {
    const requestId = ++detailRequestIdRef.current;
    setDetailLoadFailed(false);
    setDetail(delivery);
    try {
      const full = await api.getDelivery(delivery.id);
      if (requestId !== detailRequestIdRef.current) return;
      setDetail(full);
    } catch {
      if (requestId !== detailRequestIdRef.current) return;
      setDetailLoadFailed(true);
      toast.error("Failed to load delivery details");
    }
  };

  useEffect(() => {
    pageRef.current = 0;
    fetchPage([]);
  }, [fetchPage]);

  useEffect(() => {
    if (refreshToken > 0) {
      pageRef.current = 0;
      void fetchPage([]);
    }
  }, [fetchPage, refreshToken]);

  useRealtime("alert.fired", () => {
    pageRef.current = 0;
    void fetchPage([]);
  });

  useRealtime("alert.resolved", () => {
    pageRef.current = 0;
    void fetchPage([]);
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !isLoading) {
          void fetchPage(null);
        }
      },
      { root, rootMargin: "400px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchPage, hasMore, loadingMore, isLoading]);

  const sIcon = (s: string) => {
    const icon =
      s === "success" ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      ) : s === "failed" ? (
        <XCircle className="h-4 w-4 text-red-500" />
      ) : (
        <Clock className="h-4 w-4 text-amber-500" />
      );

    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">{icon}</span>
    );
  };

  const filteredDeliveries = useMemo(() => {
    if (!search) return deliveries;
    const q = search.toLowerCase();
    return deliveries.filter((delivery) =>
      [
        delivery.webhookName,
        delivery.webhookId,
        delivery.eventType,
        delivery.severity,
        delivery.responseStatus != null ? String(delivery.responseStatus) : "",
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [deliveries, search]);

  if (isLoading && deliveries.length === 0) return <LoadingSpinner />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchFilterBar
        placeholder="Search by webhook, event, severity, or HTTP status..."
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={() => setSearch(searchInput)}
        hasActiveFilters={statusFilter !== "all" || search !== ""}
        onReset={() => {
          setSearchInput("");
          setSearch("");
          setStatusFilter("all");
        }}
        filters={
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="success">Success</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="retrying">Retrying</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {deliveries.length === 0 ? (
        <EmptyState message="No deliveries yet. Delivery attempts will appear here when alerts fire." />
      ) : (
        <ResourceListFrame minWidth={896} innerClassName="flex flex-col">
          <ResourceListHeaderTable columns={DELIVERY_COLUMNS} />
          <div ref={scrollRef} className="max-h-[calc(100dvh-18rem)] overflow-auto">
            <ResourceListTable
              columns={DELIVERY_COLUMNS}
              bodyClassName="[&>tr:last-child]:border-b-0"
            >
              {filteredDeliveries.length === 0 ? (
                <ResourceListRow className="opacity-100">
                  <ResourceListCell colSpan={8} contentClassName="block p-0">
                    <EmptyState message="No deliveries match the current search." embedded />
                  </ResourceListCell>
                </ResourceListRow>
              ) : (
                filteredDeliveries.map((d) => (
                  <ResourceListRow
                    key={d.id}
                    interactive
                    onClick={() => void openDeliveryDetail(d)}
                  >
                    <ResourceListCell>{sIcon(d.status)}</ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm font-medium">
                        {d.webhookName ?? d.webhookId.slice(0, 8)}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="min-w-0">
                      <span className="truncate font-mono text-sm text-muted-foreground">
                        {d.eventType}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      <Badge variant={SEV_BADGE[d.severity] ?? "secondary"}>{d.severity}</Badge>
                    </ResourceListCell>
                    <ResourceListCell>
                      {d.responseStatus ? (
                        <Badge variant={d.responseStatus < 300 ? "success" : "destructive"}>
                          {d.responseStatus}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm text-muted-foreground">
                        {d.responseTimeMs != null ? `${d.responseTimeMs}ms` : "—"}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm text-muted-foreground">
                        {d.attempt}/{d.maxAttempts}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-xs text-muted-foreground">
                        {new Date(d.createdAt).toLocaleString()}
                      </span>
                    </ResourceListCell>
                  </ResourceListRow>
                ))
              )}
              <ResourceListRow className="border-b-0 opacity-100">
                <ResourceListCell colSpan={8} contentClassName="block p-0">
                  <div
                    ref={sentinelRef}
                    className="flex min-h-12 items-center justify-center px-4 py-3 text-xs text-muted-foreground"
                  >
                    {loadingMore
                      ? "Loading more..."
                      : !hasMore && deliveries.length > 0
                        ? "End of logs"
                        : null}
                  </div>
                </ResourceListCell>
              </ResourceListRow>
            </ResourceListTable>
          </div>
        </ResourceListFrame>
      )}
      {detail && (
        <Dialog
          open={detailOpen}
          onOpenChange={(open) => {
            if (!open) {
              detailRequestIdRef.current++;
              setDetailLoadFailed(false);
            }
            onDetailOpenChange(open);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Delivery Details</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-muted-foreground">Status:</span>{" "}
                  <Badge variant={STATUS_BADGE[detail.status]} size="inline">
                    {detail.status}
                  </Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">Event:</span> {detail.eventType}
                </div>
                <div>
                  <span className="text-muted-foreground">HTTP:</span>{" "}
                  {detail.responseStatus ? (
                    <Badge
                      variant={detail.responseStatus < 300 ? "success" : "destructive"}
                      size="inline"
                    >
                      {detail.responseStatus}
                    </Badge>
                  ) : (
                    "N/A"
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">Time:</span>{" "}
                  {detail.responseTimeMs != null ? `${detail.responseTimeMs}ms` : "N/A"}
                </div>
                <div>
                  <span className="text-muted-foreground">Attempt:</span> {detail.attempt}/
                  {detail.maxAttempts}
                </div>
                <div>
                  <span className="text-muted-foreground">Created:</span>{" "}
                  {new Date(detail.createdAt).toLocaleString()}
                </div>
              </div>
              {detail.error && (
                <div>
                  <p className="text-sm font-medium mb-1">Error</p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap">
                    {detail.error}
                  </pre>
                </div>
              )}
              {(detail.requestBody ?? detail.requestBodyPreview) && (
                <div>
                  <p className="text-sm font-medium mb-1">Request Body</p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap max-h-[200px] overflow-auto font-mono">
                    {detail.requestBody ?? detail.requestBodyPreview}
                  </pre>
                  {!detail.requestBody && detail.requestBodyTruncated && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {detailLoadFailed
                        ? "Preview truncated. Full details could not be loaded."
                        : "Preview truncated. Loading full details..."}
                    </p>
                  )}
                </div>
              )}
              {(detail.responseBody ?? detail.responseBodyPreview) && (
                <div>
                  <p className="text-sm font-medium mb-1">Response Body</p>
                  <pre className="bg-muted p-3 rounded text-xs whitespace-pre-wrap max-h-[200px] overflow-auto font-mono">
                    {detail.responseBody ?? detail.responseBodyPreview}
                  </pre>
                  {!detail.responseBody && detail.responseBodyTruncated && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {detailLoadFailed
                        ? "Preview truncated. Full details could not be loaded."
                        : "Preview truncated. Loading full details..."}
                    </p>
                  )}
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
