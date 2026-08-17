import { CheckCircle2, Clock, RotateCcw, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { SiemDelivery, SiemDeliveryStatus, SiemDestination } from "@/types";

export const SIEM_DELIVERY_PAGE_SIZE = 100;

const STATUS_BADGE: Record<
  SiemDeliveryStatus,
  "success" | "destructive" | "warning" | "secondary"
> = {
  queued: "secondary",
  delivering: "warning",
  retrying: "warning",
  delivered: "success",
  failed: "destructive",
  paused: "secondary",
  discarded: "secondary",
};

const DELIVERY_COLUMNS: ResourceListColumn<SiemDelivery>[] = [
  { id: "status", label: "", width: "56px" },
  { id: "destination", label: "Destination", width: "220px" },
  { id: "action", label: "Audit action" },
  { id: "http", label: "HTTP", width: "96px" },
  { id: "time", label: "Time", width: "96px" },
  { id: "attempt", label: "Attempt", width: "100px" },
  { id: "when", label: "When", width: "180px" },
];

export function SiemDeliveryLogTab({
  refreshToken,
  canManage,
  initialDestinationId,
  onDestinationFilterChange,
}: {
  refreshToken: number;
  canManage: boolean;
  initialDestinationId?: string | null;
  onDestinationFilterChange?: (destinationId: string | null) => void;
}) {
  const [deliveries, setDeliveries] = useState<SiemDelivery[]>(
    () => api.getCached<SiemDelivery[]>("audit:siem:deliveries:all") ?? []
  );
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<SiemDelivery[]>("audit:siem:deliveries:all") === undefined
  );
  const initialLoading = useInitialLoading(isLoading);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | SiemDeliveryStatus>("all");
  const [destinations, setDestinations] = useState<SiemDestination[]>(
    () => api.getCached<SiemDestination[]>("audit:siem:destinations") ?? []
  );
  const [destinationFilter, setDestinationFilter] = useState(() => initialDestinationId ?? "all");
  const {
    open: detailOpen,
    value: detail,
    setValue: setDetail,
    onOpenChange: onDetailOpenChange,
  } = useDeferredDialogState<SiemDelivery>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const pageRef = useRef(0);
  const requestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const loadDestinations = useCallback(async () => {
    try {
      const data = (await api.listSiemDestinations({ limit: 100 })).data;
      api.setCache("audit:siem:destinations", data);
      setDestinations(data);
    } catch {
      // The delivery log remains useful even if the optional filter labels cannot load.
    }
  }, []);

  const fetchPage = useCallback(
    async (resetTo: SiemDelivery[] | null) => {
      const nextPage = resetTo ? 1 : pageRef.current + 1;
      const requestId = ++requestIdRef.current;
      const cacheKey =
        destinationFilter === "all"
          ? `audit:siem:deliveries:${statusFilter}`
          : `audit:siem:deliveries:${statusFilter}:destination:${destinationFilter}`;
      if (resetTo) {
        const cached = api.getCached<SiemDelivery[]>(cacheKey);
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
        const result = await api.listSiemDeliveries({
          page: nextPage,
          limit: SIEM_DELIVERY_PAGE_SIZE,
          destinationId: destinationFilter === "all" ? undefined : destinationFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
        });
        if (requestId !== requestIdRef.current) return;
        const fetched = result.data ?? [];
        const totalPages = result.totalPages ?? 1;
        pageRef.current = nextPage;
        setDeliveries((current) => {
          const next = resetTo ? fetched : [...current, ...fetched];
          if (resetTo) {
            api.setCache(cacheKey, next);
            api.setCache(`${cacheKey}:has-more`, nextPage < totalPages);
          }
          return next;
        });
        setHasMore(nextPage < totalPages);
      } catch {
        toast.error("Failed to load SIEM deliveries");
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [destinationFilter, statusFilter]
  );

  const refresh = useCallback(() => {
    pageRef.current = 0;
    void fetchPage([]);
  }, [fetchPage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    void loadDestinations();
  }, [loadDestinations]);

  useEffect(() => {
    setDestinationFilter(initialDestinationId ?? "all");
  }, [initialDestinationId]);

  useEffect(() => {
    if (refreshToken > 0) refresh();
  }, [refresh, refreshToken]);

  useRealtime("siem.delivery.changed", refresh);
  useRealtime("siem.destination.changed", () => {
    void loadDestinations();
    refresh();
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
  }, [fetchPage, hasMore, isLoading, loadingMore]);

  const openDetail = async (delivery: SiemDelivery) => {
    const requestId = ++detailRequestIdRef.current;
    setDetailLoading(true);
    setDetail(delivery);
    try {
      const full = await api.getSiemDelivery(delivery.id);
      if (requestId === detailRequestIdRef.current) setDetail(full);
    } catch (error) {
      if (requestId === detailRequestIdRef.current) {
        toast.error(
          error instanceof Error ? error.message : "Failed to load SIEM delivery details"
        );
      }
    } finally {
      if (requestId === detailRequestIdRef.current) setDetailLoading(false);
    }
  };

  const requeue = async () => {
    if (!detail || detail.status !== "failed") return;
    if (!requireLicenseFeature("siem-export", "SIEM delivery requeue")) return;
    setRequeueing(true);
    try {
      await api.requeueSiemDelivery(detail.id);
      toast.success("SIEM delivery requeued");
      setDetail({ ...detail, status: "queued", attempt: 0, error: null });
      refresh();
    } catch (error) {
      if (!handleLicenseApiError(error, "SIEM delivery requeue")) {
        toast.error(error instanceof Error ? error.message : "Failed to requeue SIEM delivery");
      }
    } finally {
      setRequeueing(false);
    }
  };

  const filteredDeliveries = useMemo(() => {
    if (!search) return deliveries;
    const query = search.toLowerCase();
    return deliveries.filter((delivery) =>
      [
        delivery.destinationName,
        delivery.destinationId,
        delivery.action,
        delivery.auditLogId,
        delivery.responseStatus != null ? String(delivery.responseStatus) : "",
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
  }, [deliveries, search]);

  const deliveryFooterText = loadingMore ? "Loading more..." : !hasMore ? "End of logs" : null;

  const changeDestinationFilter = (value: string) => {
    setDestinationFilter(value);
    onDestinationFilterChange?.(value === "all" ? null : value);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchFilterBar
        placeholder="Search by destination, audit action, ID, or HTTP status..."
        search={searchInput}
        onSearchChange={setSearchInput}
        onSearchSubmit={() => setSearch(searchInput)}
        hasActiveFilters={statusFilter !== "all" || destinationFilter !== "all" || search !== ""}
        onReset={() => {
          setSearchInput("");
          setSearch("");
          setStatusFilter("all");
          changeDestinationFilter("all");
        }}
        filters={
          <div className="flex flex-wrap gap-2">
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="delivering">Delivering</SelectItem>
                <SelectItem value="retrying">Retrying</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="discarded">Discarded</SelectItem>
              </SelectContent>
            </Select>
            <Select value={destinationFilter} onValueChange={changeDestinationFilter}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Destination" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All destinations</SelectItem>
                {destinations.map((destination) => (
                  <SelectItem key={destination.id} value={destination.id}>
                    {destination.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      {initialLoading && deliveries.length === 0 ? (
        <SiemDeliveryRowsSkeleton />
      ) : deliveries.length === 0 ? (
        <EmptyState message="No SIEM deliveries yet. Audit activity will appear here after a destination is enabled." />
      ) : (
        <ResourceListFrame minWidth={860} innerClassName="flex flex-col">
          <ResourceListHeaderTable columns={DELIVERY_COLUMNS} />
          <div ref={scrollRef} className="max-h-[calc(100dvh-18rem)] overflow-auto">
            <ResourceListTable
              columns={DELIVERY_COLUMNS}
              bodyClassName="[&>tr:last-child]:border-b-0"
            >
              {filteredDeliveries.length === 0 ? (
                <ResourceListRow className="opacity-100">
                  <ResourceListCell colSpan={7} contentClassName="block p-0">
                    <EmptyState message="No SIEM deliveries match the current search." embedded />
                  </ResourceListCell>
                </ResourceListRow>
              ) : (
                filteredDeliveries.map((delivery) => (
                  <ResourceListRow
                    key={delivery.id}
                    interactive
                    onClick={() => void openDetail(delivery)}
                  >
                    <ResourceListCell>{statusIcon(delivery.status)}</ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm font-medium">
                        {delivery.destinationName ?? delivery.destinationId.slice(0, 8)}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell contentClassName="min-w-0">
                      <span className="truncate font-mono text-sm text-muted-foreground">
                        {delivery.action ?? delivery.auditLogId}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      {delivery.responseStatus ? (
                        <Badge variant={delivery.responseStatus < 300 ? "success" : "destructive"}>
                          {delivery.responseStatus}
                        </Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm text-muted-foreground">
                        {delivery.responseTimeMs != null ? `${delivery.responseTimeMs}ms` : "—"}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-sm text-muted-foreground">
                        {delivery.attempt}/{delivery.maxAttempts}
                      </span>
                    </ResourceListCell>
                    <ResourceListCell>
                      <span className="text-xs text-muted-foreground">
                        {new Date(delivery.createdAt).toLocaleString()}
                      </span>
                    </ResourceListCell>
                  </ResourceListRow>
                ))
              )}
              <ResourceListRow className="border-b-0 opacity-100">
                <ResourceListCell colSpan={7} contentClassName="min-h-0 p-0">
                  <div
                    ref={sentinelRef}
                    className={`flex w-full items-center justify-center px-3 text-xs text-muted-foreground ${
                      deliveryFooterText ? "h-8" : "h-px overflow-hidden"
                    }`}
                    aria-live="polite"
                  >
                    {deliveryFooterText}
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
              detailRequestIdRef.current += 1;
              setDetailLoading(false);
            }
            onDetailOpenChange(open);
          }}
        >
          <DialogContent
            aria-describedby={undefined}
            className="max-w-[calc(100vw-2rem)] sm:max-w-3xl"
          >
            <DialogHeader>
              <DialogTitle>SIEM Delivery Details</DialogTitle>
            </DialogHeader>
            <div className="min-w-0 space-y-4 pr-1">
              <div className="grid gap-3 text-sm sm:grid-cols-6">
                <DeliveryDetail className="sm:col-span-2" label="Status">
                  <Badge variant={STATUS_BADGE[detail.status]} size="inline">
                    {detail.status}
                  </Badge>
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-2" label="Destination">
                  {detail.destinationName ?? detail.destinationId}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-2" label="Audit action">
                  {detail.payload?.data.action ?? detail.action ?? "—"}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-2" label="HTTP">
                  {detail.responseStatus ? (
                    <Badge
                      variant={detail.responseStatus < 300 ? "success" : "destructive"}
                      size="inline"
                    >
                      {detail.responseStatus}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-2" label="Response time">
                  {detail.responseTimeMs != null ? `${detail.responseTimeMs}ms` : "—"}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-2" label="Attempt">
                  {detail.attempt}/{detail.maxAttempts}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-3" label="Created">
                  {new Date(detail.createdAt).toLocaleString()}
                </DeliveryDetail>
                <DeliveryDetail className="sm:col-span-3" label="Next retry">
                  {detail.nextRetryAt ? new Date(detail.nextRetryAt).toLocaleString() : "—"}
                </DeliveryDetail>
              </div>
              {detail.payload && (
                <div className="border border-border bg-card">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="text-sm font-medium">Exported event</h3>
                  </div>
                  <pre className="overflow-x-auto p-4 text-xs whitespace-pre-wrap">
                    {JSON.stringify(detail.payload, null, 2)}
                  </pre>
                </div>
              )}
              {detailLoading && (
                <p className="text-xs text-muted-foreground">
                  Loading complete safe event details...
                </p>
              )}
              {detail.error && (
                <div className="border border-border bg-card">
                  <div className="border-b border-border px-4 py-3">
                    <h3 className="text-sm font-medium">Delivery error</h3>
                  </div>
                  <pre className="overflow-x-auto p-4 text-xs whitespace-pre-wrap">
                    {detail.error}
                  </pre>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Collector response bodies, secrets, and full audit details are intentionally not
                retained or shown.
              </p>
            </div>
            {canManage && detail.status === "failed" && (
              <DialogFooter>
                <Button variant="outline" onClick={() => void requeue()} disabled={requeueing}>
                  <RotateCcw className="h-4 w-4" />{" "}
                  {requeueing ? "Requeueing..." : "Requeue delivery"}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function DeliveryDetail({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const textValue = typeof children === "string" ? children : undefined;

  return (
    <div className={`min-w-0 rounded-md border border-border p-3 ${className}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="truncate font-mono text-xs" title={textValue}>
        {children}
      </div>
    </div>
  );
}

function statusIcon(status: SiemDeliveryStatus) {
  const icon =
    status === "delivered" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
    ) : status === "failed" ? (
      <XCircle className="h-4 w-4 text-red-500" />
    ) : (
      <Clock className="h-4 w-4 text-warning" />
    );
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">{icon}</span>
  );
}

function SiemDeliveryRowsSkeleton() {
  return (
    <ResourceListFrame
      minWidth={860}
      innerClassName="flex flex-col"
      aria-label="Loading SIEM delivery log"
    >
      <ResourceListHeaderTable columns={DELIVERY_COLUMNS} />
      <ResourceListTable columns={DELIVERY_COLUMNS} bodyClassName="[&>tr:last-child]:border-b-0">
        {Array.from({ length: 6 }, (_, index) => (
          <ResourceListRow key={index} className="opacity-100">
            <ResourceListCell>
              <Skeleton className="h-8 w-8" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-4 w-28" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-4 w-36" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-5 w-12" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-4 w-12" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-4 w-10" />
            </ResourceListCell>
            <ResourceListCell>
              <Skeleton className="h-4 w-32" />
            </ResourceListCell>
          </ResourceListRow>
        ))}
      </ResourceListTable>
    </ResourceListFrame>
  );
}
