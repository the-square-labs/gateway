import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CertificateIssueDialog } from "@/components/certificates/CertificateIssueDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { daysUntil, formatDate } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useCertificatesStore } from "@/stores/certificates";
import { useUIStore } from "@/stores/ui";
import type { Certificate, CertificateStatus, CertificateType } from "@/types";

const statusOptions: { value: CertificateStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

const typeOptions: { value: CertificateType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "tls-server", label: "TLS Server" },
  { value: "tls-client", label: "TLS Client" },
  { value: "code-signing", label: "Code Signing" },
  { value: "email", label: "Email" },
];

export function Certificates() {
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const { cas, fetchCAs } = useCAStore();
  const {
    certificates,
    isLoading,
    isLoadingMore,
    filters,
    hasMore,
    total,
    fetchCertificates,
    fetchNextPage,
    setFilters,
    resetFilters,
  } = useCertificatesStore();
  const [searchInput, setSearchInput] = useState(filters.search);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void showSystemCertificates;
    fetchCertificates();
  }, [fetchCertificates, showSystemCertificates]);

  useRealtime("cert.changed", () => {
    fetchCertificates();
  });

  useRealtime("ca.changed", () => {
    if (hasScope("pki:ca:view:root")) {
      fetchCAs();
    }
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || isLoadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchNextPage();
      },
      { root: scrollRef.current, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNextPage, hasMore, isLoadingMore]);

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.status !== "active" ||
    filters.type !== "all" ||
    filters.caId !== "all" ||
    filters.search !== "";
  const certificateColumns: DataTableColumn<Certificate>[] = [
    {
      key: "common-name",
      header: "Common Name",
      width: "minmax(220px, 1.4fr)",
      render: (cert) => (
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{cert.commonName}</p>
            {cert.isSystem && (
              <Badge variant="outline" size="inline">
                System
              </Badge>
            )}
          </div>
          {(cert.sans?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">+{cert.sans.length} SANs</p>
          )}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      width: "150px",
      render: (cert) => <Badge variant="secondary">{cert.type}</Badge>,
    },
    {
      key: "issuing-ca",
      header: "Issuing CA",
      width: "minmax(180px, 1fr)",
      truncate: true,
      render: (cert) => (
        <span className="text-sm text-muted-foreground">{cert.issuerDn || cert.caId}</span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      width: "140px",
      render: (cert) => {
        const expDays = daysUntil(cert.notAfter);
        return (
          <span
            className={`text-sm ${
              expDays <= 30 && expDays > 0
                ? "text-warning-foreground"
                : expDays <= 0
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            {formatDate(cert.notAfter)}
          </span>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      width: "120px",
      render: (cert) => <StatusBadge status={cert.status} />,
    },
  ];

  return (
    <PageTransition>
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-6">
        {/* Header */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Certificates</h1>
              <p className="text-sm text-muted-foreground">{total} certificates total</p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={
              hasScope("pki:cert:issue")
                ? [
                    {
                      label: "Issue Certificate",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setIssueDialogOpen(true),
                    },
                  ]
                : []
            }
          >
            {hasScope("pki:cert:issue") && (
              <Button onClick={() => setIssueDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Issue Certificate
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        {/* Search and filters */}
        <SearchFilterBar
          className="shrink-0"
          placeholder="Search by common name, serial number..."
          search={searchInput}
          onSearchChange={setSearchInput}
          onSearchSubmit={handleSearch}
          hasActiveFilters={hasActiveFilters}
          onReset={() => {
            resetFilters();
            setSearchInput("");
          }}
          filters={
            <>
              <div className="w-40">
                <Select
                  value={filters.status}
                  onValueChange={(v) => setFilters({ status: v as CertificateStatus | "all" })}
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
              <div className="w-40">
                <Select
                  value={filters.type}
                  onValueChange={(v) => setFilters({ type: v as CertificateType | "all" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {typeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-48">
                <Select value={filters.caId} onValueChange={(v) => setFilters({ caId: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All CAs</SelectItem>
                    {(cas || []).map((ca) => (
                      <SelectItem key={ca.id} value={ca.id}>
                        {ca.commonName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          }
        />

        {/* Table */}
        {isLoading || (certificates || []).length > 0 ? (
          <div className="min-h-0 shrink">
            <DataTable
              columns={certificateColumns}
              data={certificates}
              keyFn={(cert) => cert.id}
              loading={isLoading}
              onRowClick={(cert) => navigate(`/certificates/${cert.id}`)}
              scrollRef={scrollRef}
              horizontalScroll
              minWidth="860px"
              footer={
                hasMore ? (
                  <div
                    ref={sentinelRef}
                    className="flex items-center justify-center py-3 text-xs text-muted-foreground"
                  >
                    {isLoadingMore ? "Loading more certificates..." : "Scroll to load more"}
                  </div>
                ) : undefined
              }
            />
          </div>
        ) : (
          <EmptyState
            message="No certificates."
            {...(hasScope("pki:cert:issue")
              ? { actionLabel: "Issue one", onAction: () => setIssueDialogOpen(true) }
              : {})}
            hasActiveFilters={hasActiveFilters}
            onReset={() => {
              resetFilters();
              setSearchInput("");
            }}
          />
        )}

        <CertificateIssueDialog
          open={issueDialogOpen}
          onOpenChange={setIssueDialogOpen}
          onSuccess={fetchCertificates}
        />
      </div>
    </PageTransition>
  );
}
