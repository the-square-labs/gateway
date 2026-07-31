import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CertificateIssueDialog } from "@/components/certificates/CertificateIssueDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
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
    filters,
    page,
    totalPages,
    total,
    fetchCertificates,
    setFilters,
    setPage,
    resetFilters,
  } = useCertificatesStore();
  const [searchInput, setSearchInput] = useState(filters.search);
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);

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

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.status !== "active" ||
    filters.type !== "all" ||
    filters.caId !== "all" ||
    filters.search !== "";
  const certificateColumns: SimpleTableColumn<Certificate>[] = [
    {
      id: "common-name",
      header: "Common Name",
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
      id: "type",
      header: "Type",
      render: (cert) => <span className="text-sm text-muted-foreground">{cert.type}</span>,
    },
    {
      id: "issuing-ca",
      header: "Issuing CA",
      render: (cert) => (
        <span className="text-sm text-muted-foreground">{cert.issuerDn || cert.caId}</span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
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
      id: "status",
      header: "Status",
      render: (cert) => <StatusBadge status={cert.status} />,
    },
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-3">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
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
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <LoadingSpinner className="" />
              <p className="text-sm text-muted-foreground">Loading certificates...</p>
            </div>
          </div>
        ) : (certificates || []).length > 0 ? (
          <div className="border border-border bg-card">
            <SimpleTable
              columns={certificateColumns}
              rows={certificates}
              getRowKey={(cert) => cert.id}
              onRowClick={(cert) => navigate(`/certificates/${cert.id}`)}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
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
