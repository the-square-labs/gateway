import { Cloud, MoreVertical, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SearchFilterBar } from "@/components/common/SearchFilterBar";
import { DNSChallengeVerification } from "@/components/ssl/DNSChallengeVerification";
import {
  SSLCertificateCreateDialog,
  type SSLCertificateCreateDialogDevPreview,
} from "@/components/ssl/SSLCertificateCreateDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { cn, daysUntil, formatDate, hoursUntil } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useSSLStore } from "@/stores/ssl";
import { useUIStore } from "@/stores/ui";
import type { DNSChallenge, SSLCertificate, SSLCertStatus, SSLCertType } from "@/types";

const typeOptions: { value: SSLCertType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "acme", label: "ACME" },
  { value: "upload", label: "Upload" },
  { value: "internal", label: "Internal" },
];

const statusOptions: { value: SSLCertStatus | "all"; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "pending", label: "Pending" },
  { value: "error", label: "Error" },
];

function SSLTypeBadge({ type }: { type: SSLCertType }) {
  switch (type) {
    case "acme":
      return <Badge variant="success">ACME</Badge>;
    case "upload":
      return <Badge variant="secondary">UPLOAD</Badge>;
    case "internal":
      return <Badge variant="default">INTERNAL</Badge>;
    default:
      return <Badge variant="secondary">{type}</Badge>;
  }
}

function SSLStatusBadge({ status }: { status: SSLCertStatus }) {
  switch (status) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "pending":
      return <Badge variant="warning">Pending</Badge>;
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export function SSLCertificates() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogDevPreview, setCreateDialogDevPreview] =
    useState<SSLCertificateCreateDialogDevPreview | null>(null);
  const { hasScope } = useAuthStore();
  const canViewSystemCertificates = useAuthStore((s) => s.hasScope("admin:details:certificates"));
  const showSystemCertificatePreference = useUIStore((s) => s.showSystemCertificates);
  const showSystemCertificates = canViewSystemCertificates && showSystemCertificatePreference;
  const modal = useUIStore((s) => s.modal);
  const closeModal = useUIStore((s) => s.closeModal);

  // Open dialog from command palette
  useEffect(() => {
    if (modal?.type === "createSSLCert") {
      setCreateDialogOpen(true);
      closeModal();
    }
  }, [modal, closeModal]);

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = ((window as Window & { gatewayDev?: Record<string, unknown> }).gatewayDev ??=
      {});
    const openDns01Modal = () => {
      setCreateDialogDevPreview({
        mode: "dns-01",
        domains: ["example.com", "*.example.com"],
        dnsChallenges: [
          {
            domain: "example.com",
            recordName: "_acme-challenge.example.com",
            recordValue: "dev-preview-token-example-com-8f4d9b2a",
          },
          {
            domain: "*.example.com",
            recordName: "_acme-challenge.example.com",
            recordValue: "dev-preview-token-wildcard-example-com-c31a7e0f",
          },
        ],
      });
      setCreateDialogOpen(true);
    };
    const openHttp01Modal = () => {
      setCreateDialogDevPreview({
        mode: "http-01",
        domains: ["example.com"],
      });
      setCreateDialogOpen(true);
    };
    gatewayDev.openSslDns01Modal = openDns01Modal;
    gatewayDev.openSslHttp01Modal = openHttp01Modal;
    (
      window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      }
    ).gatewayDevOpenSslDns01Modal = openDns01Modal;
    (
      window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      }
    ).gatewayDevOpenSslHttp01Modal = openHttp01Modal;

    return () => {
      if (gatewayDev.openSslDns01Modal === openDns01Modal) delete gatewayDev.openSslDns01Modal;
      if (gatewayDev.openSslHttp01Modal === openHttp01Modal) delete gatewayDev.openSslHttp01Modal;
      const win = window as Window & {
        gatewayDevOpenSslDns01Modal?: () => void;
        gatewayDevOpenSslHttp01Modal?: () => void;
      };
      if (win.gatewayDevOpenSslDns01Modal === openDns01Modal) {
        delete win.gatewayDevOpenSslDns01Modal;
      }
      if (win.gatewayDevOpenSslHttp01Modal === openHttp01Modal) {
        delete win.gatewayDevOpenSslHttp01Modal;
      }
    };
  }, []);
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
    renewCert,
    setAutoRenew,
    completeDNSVerify,
    deleteCert,
  } = useSSLStore();
  const [searchInput, setSearchInput] = useState(filters.search);
  type PendingRenewal = {
    certId: string;
    certName: string;
    operation: "issue" | "renewal";
    challenges: DNSChallenge[];
  };
  const {
    open: pendingRenewalOpen,
    value: pendingRenewal,
    setValue: setPendingRenewal,
    onOpenChange: onPendingRenewalOpenChange,
  } = useDeferredDialogState<PendingRenewal>();
  const [previewCert, setPreviewCert] = useState<SSLCertificate | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isVerifyingRenewal, setIsVerifyingRenewal] = useState(false);
  type RenewingCertificate = {
    id: string;
    name: string;
    challengeType: SSLCertificate["acmeChallengeType"];
  };
  const {
    open: renewingCertOpen,
    value: renewingCert,
    setValue: setRenewingCert,
  } = useDeferredDialogState<RenewingCertificate>();
  const previewCleanupTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void showSystemCertificates;
    fetchCertificates();
  }, [fetchCertificates, showSystemCertificates]);

  useRealtime("ssl.cert.changed", () => {
    fetchCertificates();
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

  useEffect(
    () => () => {
      if (previewCleanupTimerRef.current !== null) {
        window.clearTimeout(previewCleanupTimerRef.current);
      }
    },
    []
  );

  const handleSearch = () => {
    setFilters({ search: searchInput });
  };

  const hasActiveFilters =
    filters.type !== "all" || filters.status !== "active" || filters.search !== "";

  const handleRenew = async (cert: SSLCertificate) => {
    setRenewingCert({
      id: cert.id,
      name: cert.name,
      challengeType: cert.acmeChallengeType,
    });
    try {
      const result = await renewCert(cert.id);
      if ("certificate" in result && result.status === "pending_dns_verification") {
        setRenewingCert(null);
        setPendingRenewal({
          certId: result.certificate.id,
          certName: result.certificate.name,
          operation: "renewal",
          challenges: result.challenges ?? [],
        });
        toast.success("DNS renewal challenge created. Add the TXT records, then verify.");
        return;
      }
      toast.success("Certificate renewed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to renew certificate");
    } finally {
      setRenewingCert(null);
    }
  };

  const handleSetCloudflareAutoRenew = async (cert: SSLCertificate, enabled: boolean) => {
    try {
      await setAutoRenew(
        cert.id,
        enabled ? { enabled: true, provider: "cloudflare" } : { enabled: false }
      );
      toast.success(enabled ? "Cloudflare auto-renew enabled" : "Auto-renew disabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update auto-renew");
    }
  };

  const handleContinueDNSRenewal = (cert: {
    id: string;
    name: string;
    acmePendingOperation: "issue" | "renewal" | null;
    acmePendingChallenges: DNSChallenge[] | null;
  }) => {
    if (!cert.acmePendingChallenges?.length) {
      toast.error("No pending DNS challenges found for this certificate");
      return;
    }
    setPendingRenewal({
      certId: cert.id,
      certName: cert.name,
      operation: cert.acmePendingOperation ?? "issue",
      challenges: cert.acmePendingChallenges,
    });
  };

  const handleVerifyRenewal = async () => {
    if (!pendingRenewal) return;
    setIsVerifyingRenewal(true);
    try {
      await completeDNSVerify(pendingRenewal.certId);
      toast.success(
        pendingRenewal.operation === "renewal"
          ? "DNS verification complete. Certificate renewed."
          : "DNS verification complete. Certificate issued."
      );
      setPendingRenewal(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "DNS verification failed");
    } finally {
      setIsVerifyingRenewal(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Delete SSL Certificate",
      description: `Are you sure you want to delete "${name}"? This action cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await deleteCert(id);
      toast.success("Certificate deleted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete certificate";
      if (msg.includes("in use") || msg.includes("CERT_IN_USE")) {
        toast.error(
          "Cannot delete: certificate is used by proxy hosts. Remove it from proxy hosts first."
        );
      } else if (msg.includes("System") || msg.includes("SYSTEM_CERT")) {
        toast.error("System certificates cannot be deleted.");
      } else {
        toast.error(msg);
      }
    }
  };

  const openCertificatePreview = (cert: SSLCertificate) => {
    if (previewCleanupTimerRef.current !== null) {
      window.clearTimeout(previewCleanupTimerRef.current);
      previewCleanupTimerRef.current = null;
    }
    setPreviewCert(cert);
    setPreviewOpen(true);
  };

  const handlePreviewOpenChange = (open: boolean) => {
    setPreviewOpen(open);
    if (open) return;
    previewCleanupTimerRef.current = window.setTimeout(() => {
      setPreviewCert(null);
      previewCleanupTimerRef.current = null;
    }, 250);
  };

  const certificateColumns: DataTableColumn<SSLCertificate>[] = [
    {
      key: "name",
      header: "Name",
      width: "minmax(200px, 1.25fr)",
      render: (cert) => (
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{cert.name}</p>
          {cert.isSystem && (
            <Badge variant="outline" size="inline">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "domains",
      header: "Domains",
      width: "minmax(200px, 1.25fr)",
      truncate: true,
      render: (cert) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-muted-foreground">
            {cert.domainNames.slice(0, 2).join(", ") || "-"}
          </p>
          {cert.domainNames.length > 2 && (
            <p className="text-xs text-muted-foreground">+{cert.domainNames.length - 2} more</p>
          )}
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      width: "110px",
      render: (cert) => <SSLTypeBadge type={cert.type} />,
    },
    {
      key: "status",
      header: "Status",
      width: "120px",
      render: (cert) => <SSLStatusBadge status={cert.status} />,
    },
    {
      key: "expires",
      header: "Expires",
      width: "150px",
      render: (cert) => {
        const expDays = cert.notAfter ? daysUntil(cert.notAfter) : null;
        return cert.notAfter ? (
          <span
            className={cn(
              "text-sm",
              expDays !== null && expDays <= 7
                ? "font-medium text-red-600 dark:text-red-400"
                : expDays !== null && expDays <= 30
                  ? "text-warning-foreground"
                  : "text-muted-foreground"
            )}
          >
            {formatDate(cert.notAfter)}
            {expDays !== null && expDays > 0 && <span className="ml-1 text-xs">({expDays}d)</span>}
            {expDays !== null && expDays === 0 && hoursUntil(cert.notAfter) > 0 && (
              <span className="ml-1 text-xs">({hoursUntil(cert.notAfter)}h)</span>
            )}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        );
      },
    },
    {
      key: "autoRenew",
      header: "Auto-Renew",
      width: "150px",
      render: (cert) => {
        if (cert.type !== "acme") return <Badge variant="secondary">No</Badge>;
        if (cert.autoRenew && cert.autoRenewProvider === "cloudflare") {
          return <Badge variant="success">Cloudflare</Badge>;
        }
        if (cert.autoRenew && cert.acmeChallengeType !== "dns-01") {
          return <Badge variant="success">Yes</Badge>;
        }
        if (cert.autoRenew && cert.acmeChallengeType === "dns-01") {
          return <Badge variant="warning">Needs Setup</Badge>;
        }
        return (
          <Badge variant={cert.autoRenewDisabledReason ? "warning" : "secondary"}>
            {cert.autoRenewDisabledReason ? "Disabled" : "No"}
          </Badge>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "48px",
      render: (cert) => {
        const hasPendingDNSVerification =
          (cert.acmePendingOperation === "issue" || cert.acmePendingOperation === "renewal") &&
          (cert.acmePendingChallenges?.length ?? 0) > 0;
        const canContinueDNSVerification = hasScope("ssl:cert:issue") && hasPendingDNSVerification;
        const canRenewCert =
          hasScope("ssl:cert:issue") &&
          cert.type === "acme" &&
          Boolean(cert.notAfter) &&
          (cert.status === "active" || cert.status === "error") &&
          !hasPendingDNSVerification;
        const canEnableCloudflareAutoRenew =
          hasScope("ssl:cert:issue") &&
          cert.type === "acme" &&
          cert.acmeChallengeType === "dns-01" &&
          cert.status === "active" &&
          !(cert.autoRenew && cert.autoRenewProvider === "cloudflare") &&
          !hasPendingDNSVerification;
        const canDisableCloudflareAutoRenew =
          hasScope("ssl:cert:issue") &&
          cert.type === "acme" &&
          cert.acmeChallengeType === "dns-01" &&
          cert.autoRenew &&
          cert.autoRenewProvider === "cloudflare";
        const canDeleteCert = !cert.isSystem && hasScope("ssl:cert:delete");
        const hasActions =
          canContinueDNSVerification ||
          canRenewCert ||
          canEnableCloudflareAutoRenew ||
          canDisableCloudflareAutoRenew ||
          canDeleteCert;
        if (!hasActions) return null;
        return (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canContinueDNSVerification && (
                  <DropdownMenuItem onClick={() => handleContinueDNSRenewal(cert)}>
                    <RefreshCw className="h-4 w-4" />
                    Continue Verification
                  </DropdownMenuItem>
                )}
                {canRenewCert && (
                  <DropdownMenuItem onClick={() => handleRenew(cert)}>
                    <RefreshCw className="h-4 w-4" />
                    Renew
                  </DropdownMenuItem>
                )}
                {canEnableCloudflareAutoRenew && (
                  <DropdownMenuItem onClick={() => handleSetCloudflareAutoRenew(cert, true)}>
                    <Cloud className="h-4 w-4" />
                    Enable Cloudflare Auto-Renew
                  </DropdownMenuItem>
                )}
                {canDisableCloudflareAutoRenew && (
                  <DropdownMenuItem onClick={() => handleSetCloudflareAutoRenew(cert, false)}>
                    <Cloud className="h-4 w-4" />
                    Disable Auto-Renew
                  </DropdownMenuItem>
                )}
                {canDeleteCert && (
                  <DropdownMenuItem
                    onClick={() => handleDelete(cert.id, cert.name)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
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
              <h1 className="text-2xl font-bold">SSL Certificates</h1>
              <p className="text-sm text-muted-foreground">{total} certificates total</p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={
              hasScope("ssl:cert:issue")
                ? [
                    {
                      label: "Add Certificate",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setCreateDialogOpen(true),
                    },
                  ]
                : []
            }
          >
            {hasScope("ssl:cert:issue") && (
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Certificate
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        {/* Search and filters */}
        <SearchFilterBar
          placeholder="Search by name or domain..."
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
                  value={filters.type}
                  onValueChange={(v) => setFilters({ type: v as SSLCertType | "all" })}
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
              <div className="w-40">
                <Select
                  value={filters.status}
                  onValueChange={(v) => setFilters({ status: v as SSLCertStatus | "all" })}
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
            </>
          }
        />

        {(certificates || []).length > 0 || isLoading ? (
          <div className="h-[min(60dvh,42rem)] min-h-72">
            <DataTable
              columns={certificateColumns}
              data={certificates || []}
              keyFn={(cert) => cert.id}
              onRowClick={openCertificatePreview}
              scrollRef={scrollRef}
              horizontalScroll
              minWidth="1040px"
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
            message="No SSL certificates."
            {...(hasScope("ssl:cert:issue")
              ? { actionLabel: "Add one", onAction: () => setCreateDialogOpen(true) }
              : {})}
            hasActiveFilters={hasActiveFilters}
            onReset={() => {
              resetFilters();
              setSearchInput("");
            }}
          />
        )}
      </div>

      <SSLCertificateCreateDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setCreateDialogDevPreview(null);
        }}
        onCreated={fetchCertificates}
        devPreview={createDialogDevPreview}
      />
      <Dialog open={previewOpen} onOpenChange={handlePreviewOpenChange}>
        <DialogContent className="max-w-full sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>SSL Certificate Details</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs break-all">{previewCert?.name ?? ""}</span>
            </DialogDescription>
          </DialogHeader>
          {previewCert && (
            <div className="min-w-0 divide-y divide-border overflow-hidden border border-border bg-card">
              {[
                ["Name", previewCert.name],
                ["Domains", previewCert.domainNames.join(", ") || "-"],
                ["Type", previewCert.type],
                ["Status", previewCert.status],
                ["Provider", previewCert.acmeProvider ?? "-"],
                ["Challenge", previewCert.acmeChallengeType ?? "-"],
                ["Valid From", previewCert.notBefore ? formatDate(previewCert.notBefore) : "-"],
                ["Valid Until", previewCert.notAfter ? formatDate(previewCert.notAfter) : "-"],
                [
                  "Auto-Renew",
                  previewCert.autoRenewProvider === "cloudflare" && previewCert.autoRenew
                    ? `Cloudflare (${previewCert.autoRenewDnsBindings?.[0]?.connectorName ?? "connector"})`
                    : previewCert.autoRenew
                      ? previewCert.acmeChallengeType === "dns-01"
                        ? "Needs Cloudflare setup"
                        : "Yes"
                      : "No",
                ],
                ["Auto-Renew Disabled", previewCert.autoRenewDisabledReason ?? "-"],
                [
                  "Last Renewed",
                  previewCert.lastRenewedAt ? formatDate(previewCert.lastRenewedAt) : "-",
                ],
                ["System", previewCert.isSystem ? "Yes" : "No"],
                ["Created", formatDate(previewCert.createdAt)],
                ["Updated", formatDate(previewCert.updatedAt)],
                ["Error", previewCert.renewalError ?? "-"],
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
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={renewingCertOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Renewing Certificate</DialogTitle>
            <DialogDescription>{renewingCert?.name}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-4 border border-border bg-muted/20 px-4 py-4">
            <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {renewingCert?.challengeType === "dns-01"
                  ? "Preparing DNS-01 renewal"
                  : "Renewal in progress"}
              </p>
              <p className="text-sm text-muted-foreground">
                {renewingCert?.challengeType === "dns-01"
                  ? "Gateway is creating or checking DNS TXT records and will continue automatically when Cloudflare is configured."
                  : "Gateway is requesting and deploying the renewed certificate."}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={pendingRenewalOpen} onOpenChange={onPendingRenewalOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {pendingRenewal?.operation === "renewal" ? "Verify DNS Renewal" : "Verify DNS Issue"}
            </DialogTitle>
            <DialogDescription>{pendingRenewal?.certName}</DialogDescription>
          </DialogHeader>
          {pendingRenewal && (
            <DNSChallengeVerification
              challenges={pendingRenewal.challenges}
              onVerify={handleVerifyRenewal}
              isVerifying={isVerifyingRenewal}
              title={
                pendingRenewal.operation === "renewal"
                  ? "DNS Renewal Records"
                  : "DNS Challenge Records"
              }
              description={
                pendingRenewal.operation === "renewal"
                  ? "Add or confirm these DNS TXT records, then verify to replace the existing certificate in place."
                  : "Add or confirm these DNS TXT records, then verify to issue the certificate."
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
