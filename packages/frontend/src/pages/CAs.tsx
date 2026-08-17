import { CornerDownRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CACreateDialog } from "@/components/ca/CACreateDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { daysUntil, formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useUIStore } from "@/stores/ui";
import type { CA } from "@/types";

type StatusFilter = "active" | "all";
type CARow = { ca: CA; depth: number };

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active only" },
  { value: "all", label: "All statuses" },
];

export function CAs() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const { cas, fetchCAs, isLoading } = useCAStore();
  const initialLoading = useInitialLoading(isLoading);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createIntermediateParentId, setCreateIntermediateParentId] = useState<
    string | undefined
  >();
  const modal = useUIStore((s) => s.modal);
  const closeModal = useUIStore((s) => s.closeModal);

  useEffect(() => {
    if (modal?.type === "createCA") {
      setCreateIntermediateParentId(undefined);
      setCreateDialogOpen(true);
      closeModal();
    }
  }, [modal, closeModal]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;

  useEffect(() => {
    void showSystemCertificates;
    fetchCAs();
  }, [fetchCAs, showSystemCertificates]);

  useRealtime("ca.changed", () => {
    fetchCAs();
  });

  useRealtime("cert.changed", () => {
    fetchCAs();
  });

  const allCAs = cas || [];
  const filteredByStatus =
    statusFilter === "all" ? allCAs : allCAs.filter((ca) => ca.status === "active");
  const visibleCAs = search
    ? filteredByStatus.filter((ca) => ca.commonName.toLowerCase().includes(search.toLowerCase()))
    : filteredByStatus;
  const visibleCAIds = new Set(visibleCAs.map((ca) => ca.id));
  const topLevelCAs = visibleCAs.filter((ca) => !ca.parentId || !visibleCAIds.has(ca.parentId));
  const activeCAs = allCAs.filter((ca) => ca.status === "active");
  const activeUserManagedCAs = activeCAs.filter(
    (ca) => !ca.isSystem && hasScope(`pki:ca:create:intermediate:${ca.id}`)
  );
  const totalCerts = allCAs.reduce((sum, ca) => sum + (ca.certCount || 0), 0);
  const canCreateRoot = hasScope("pki:ca:create:root");
  const canCreateIntermediate = hasScopedAccess("pki:ca:create:intermediate");

  const getChildren = (parentId: string) => visibleCAs.filter((ca) => ca.parentId === parentId);
  const flattenCARows = (items: CA[], depth = 0): CARow[] =>
    items.flatMap((ca) => [{ ca, depth }, ...flattenCARows(getChildren(ca.id), depth + 1)]);
  const caRows = flattenCARows(topLevelCAs);
  const caColumns: SimpleTableColumn<CARow>[] = [
    {
      id: "common-name",
      header: "Common Name",
      render: ({ ca, depth }) => (
        <div className="flex items-center gap-1.5" style={{ paddingLeft: `${depth * 24}px` }}>
          {depth > 0 && <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
          <span className="text-sm font-medium">{ca.commonName}</span>
          {ca.isSystem && (
            <Badge variant="outline" size="inline">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "algorithm",
      header: "Algorithm",
      render: ({ ca }) => <Badge variant="secondary">{ca.keyAlgorithm}</Badge>,
    },
    {
      id: "certificates",
      header: "Certificates",
      render: ({ ca }) => <Badge variant="secondary">{ca.certCount}</Badge>,
    },
    {
      id: "expires",
      header: "Expires",
      render: ({ ca }) => {
        const expDays = daysUntil(ca.notAfter);
        return (
          <span
            className={`text-sm ${
              expDays <= 90 && expDays > 0
                ? "text-warning-foreground"
                : expDays <= 0
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            {formatDate(ca.notAfter)}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      render: ({ ca }) => <StatusBadge status={ca.status} />,
    },
  ];

  const hasActiveFilters = statusFilter !== "active" || search !== "";

  const resetFilters = () => {
    setSearch("");
    setStatusFilter("active");
  };

  return (
    <PageTransition>
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-6">
        {/* Header */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Certificate Authorities</h1>
              <p className="text-sm text-muted-foreground">
                {activeCAs.length} active &middot; {totalCerts} certificate
                {totalCerts !== 1 ? "s" : ""} issued
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canCreateIntermediate
                ? [
                    {
                      label: "Create Intermediate",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => {
                        setCreateIntermediateParentId("pick");
                        setCreateDialogOpen(true);
                      },
                      disabled: activeUserManagedCAs.length === 0,
                    },
                  ]
                : []),
              ...(canCreateRoot
                ? [
                    {
                      label: "Create Root CA",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => {
                        setCreateIntermediateParentId(undefined);
                        setCreateDialogOpen(true);
                      },
                    },
                  ]
                : []),
            ]}
          >
            {canCreateIntermediate && (
              <Button
                variant="outline"
                onClick={() => {
                  setCreateIntermediateParentId("pick");
                  setCreateDialogOpen(true);
                }}
                disabled={activeUserManagedCAs.length === 0}
              >
                <Plus className="h-4 w-4" />
                Create Intermediate
              </Button>
            )}
            {canCreateRoot && (
              <Button
                onClick={() => {
                  setCreateIntermediateParentId(undefined);
                  setCreateDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" />
                Create Root CA
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        {/* Search and filters */}
        <SearchFilterBar
          className="shrink-0"
          placeholder="Search by common name..."
          search={search}
          onSearchChange={setSearch}
          hasActiveFilters={hasActiveFilters}
          onReset={resetFilters}
          filters={
            <div className="w-40">
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as StatusFilter)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />

        {/* Table */}
        {initialLoading && visibleCAs.length === 0 ? (
          <Skeleton />
        ) : visibleCAs.length > 0 ? (
          <div className="min-h-0 shrink overflow-auto border border-border bg-card">
            <SimpleTable
              columns={caColumns}
              rows={caRows}
              getRowKey={({ ca }) => ca.id}
              onRowClick={({ ca }) => navigate(`/cas/${ca.id}`)}
              loading={isLoading}
            />
          </div>
        ) : (
          <EmptyState
            message="No certificate authorities."
            {...(canCreateRoot
              ? {
                  actionLabel: "Create one",
                  onAction: () => {
                    setCreateIntermediateParentId(undefined);
                    setCreateDialogOpen(true);
                  },
                }
              : {})}
            hasActiveFilters={hasActiveFilters}
            onReset={resetFilters}
          />
        )}

        <CACreateDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          parentId={createIntermediateParentId}
        />
      </div>
    </PageTransition>
  );
}
