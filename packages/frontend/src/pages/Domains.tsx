import {
  FolderPlus,
  Globe,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { AddDomainDialog } from "@/components/domains/AddDomainDialog";
import { DnsStatusBadge } from "@/components/domains/DnsStatusBadge";
import { DomainDetailDialog } from "@/components/domains/DomainDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import type { DnsStatus, Domain, DomainDnsConflictDetails } from "@/types";

const DOMAIN_FOLDER_LIST_CACHE_KEY = "domains:list:folder-view";

export function Domains() {
  const { hasScope } = useAuthStore();
  const canCreateDomain = hasScope("integrations:cloudflare:dns:edit");
  const canDeleteDns = hasScope("integrations:cloudflare:dns:delete");
  const canDeleteDomain = hasScope("domains:delete") || canDeleteDns;
  const canCheckDns = hasScope("domains:edit");
  const canIssueCert = canCheckDns && hasScope("ssl:cert:issue");

  const cachedDomains = api.getCached<{ data: Domain[] }>(DOMAIN_FOLDER_LIST_CACHE_KEY);
  const [domains, setDomains] = useState<Domain[]>(cachedDomains?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cachedDomains);
  const [cloudflareReady, setCloudflareReady] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DnsStatus | "all">("all");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadDomains = useCallback(async () => {
    try {
      const [result, connectors] = await Promise.all([
        api.listDomains({
          page: 1,
          limit: 1000,
        }),
        api.listCloudflareConnectors({ enabled: true }).catch(() => []),
      ]);
      setCloudflareReady(
        connectors.some(
          (connector) =>
            connector.enabled &&
            connector.syncStatus !== "error" &&
            (connector.zones?.length ?? 0) > 0
        )
      );
      setDomains(result.data);
      api.setCache(DOMAIN_FOLDER_LIST_CACHE_KEY, result);
    } catch {
      toast.error("Failed to load domains");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  useRealtime("domain.changed", () => {
    loadDomains();
  });

  useRealtime("proxy.host.changed", () => {
    loadDomains();
  });

  useRealtime("ssl.cert.changed", () => {
    loadDomains();
  });

  useRealtime("integration.connector.changed", () => {
    loadDomains();
  });

  const handleCheckDns = async (d: Domain) => {
    try {
      await api.checkDomainDns(d.id);
      toast.success(`DNS check complete for ${d.domain}`);
      loadDomains();
    } catch {
      toast.error("DNS check failed");
    }
  };

  const handleIssueCert = async (d: Domain) => {
    try {
      await api.issueDomainCert(d.id);
      toast.success(`Certificate issued for ${d.domain}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue cert");
    }
  };

  const handleDelete = async (d: Domain) => {
    let deleteDns: boolean | undefined;
    if (d.dnsProvider === "cloudflare" && d.dnsOwnership === "matched_existing") {
      const ok = await confirm({
        title: "Delete Domain Mapping",
        description: `Remove "${d.domain}" from Gateway? The matched existing Cloudflare DNS record will be kept.`,
        confirmLabel: "Remove Mapping",
        cancelLabel: "Cancel",
        variant: "default",
      });
      if (!ok) return;
      deleteDns = false;
    } else {
      const ok = await confirm({
        title: "Delete Domain",
        description:
          d.dnsProvider === "cloudflare"
            ? `Delete "${d.domain}" and its Gateway-managed Cloudflare DNS records?`
            : `Are you sure you want to delete "${d.domain}"? This won't affect proxy hosts or certificates using this domain.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
    }
    try {
      await api.deleteDomain(d.id, deleteDns === undefined ? undefined : { deleteDns });
      toast.success("Domain deleted");
      loadDomains();
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "DOMAIN_DNS_DELETE_CHOICE_REQUIRED") {
        const details = err.details as DomainDnsConflictDetails | undefined;
        const ok = await confirm({
          title: "Delete Cloudflare DNS too?",
          description: `This domain was adopted from existing Cloudflare records. Delete those DNS records as well?${details?.recordIds?.length ? ` Records: ${details.recordIds.join(", ")}` : ""}`,
          confirmLabel: "Delete DNS",
          cancelLabel: "Keep DNS",
          variant: "destructive",
        });
        await api.deleteDomain(d.id, { deleteDns: ok });
        toast.success("Domain deleted");
        loadDomains();
        return;
      }
      const msg = err instanceof Error ? err.message : "Failed to delete domain";
      if (msg.includes("in use")) {
        toast.error(
          "Cannot delete: domain is used by proxy hosts. Remove it from proxy hosts first."
        );
      } else if (msg.includes("System")) {
        toast.error("System domains cannot be deleted.");
      } else {
        toast.error(msg);
      }
    }
  };

  const openDetail = (id: string) => {
    setDetailId(id);
    setDetailOpen(true);
  };

  const hasActiveFilters = search.trim() !== "" || statusFilter !== "all";
  const domainsAvailable = cloudflareReady !== false;
  const filteredDomains = useMemo(() => {
    const query = search.trim().toLowerCase();
    return domains.filter((domain) => {
      if (statusFilter !== "all" && domain.dnsStatus !== statusFilter) return false;
      if (!query) return true;
      return [domain.domain, domain.description].some((value) =>
        value?.toLowerCase().includes(query)
      );
    });
  }, [domains, search, statusFilter]);
  const canManageFolders = hasScope("domains:folders:manage");
  const domainColumns: ResourceListColumn<Domain>[] = [
    {
      id: "domain",
      label: "Domain",
      width: "minmax(16rem, 1fr)",
      renderCell: (d) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{d.domain}</span>
            {d.isSystem && (
              <Badge variant="outline" size="inline">
                System
              </Badge>
            )}
          </div>
          {d.description && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{d.description}</p>
          )}
        </div>
      ),
    },
    {
      id: "dns",
      label: "DNS",
      width: "8rem",
      renderCell: (d) => <DnsStatusBadge status={d.dnsStatus} />,
    },
    {
      id: "ssl",
      label: "SSL",
      width: "6rem",
      renderCell: (d) =>
        d.sslCertCount ? (
          <Badge variant="secondary">{d.sslCertCount}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
    {
      id: "proxyHosts",
      label: "Proxy Hosts",
      width: "8rem",
      renderCell: (d) =>
        d.proxyHostCount ? (
          <Badge variant="secondary">{d.proxyHostCount}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
    {
      id: "added",
      label: "Added",
      width: "8rem",
      renderCell: (d) => (
        <span className="text-sm text-muted-foreground">{formatRelativeDate(d.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      align: "right",
      width: "5rem",
      renderCell: (d) => {
        const canDeleteRow =
          !d.isSystem &&
          (d.dnsProvider !== "cloudflare" || d.dnsOwnership === "matched_existing"
            ? canDeleteDomain
            : canDeleteDns);
        if (!canCheckDns && !canIssueCert && !canDeleteRow) return null;
        return (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canCheckDns && (
                  <DropdownMenuItem onClick={() => handleCheckDns(d)}>
                    <RefreshCw className="h-4 w-4" />
                    Check DNS
                  </DropdownMenuItem>
                )}
                {canIssueCert && !d.dnsProxied && d.dnsStatus === "valid" && !d.sslCertCount && (
                  <DropdownMenuItem onClick={() => handleIssueCert(d)}>
                    <Shield className="h-4 w-4" />
                    Issue Cert
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => openDetail(d.id)}>
                  <Pencil className="h-4 w-4" />
                  Details
                </DropdownMenuItem>
                {canDeleteRow && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleDelete(d)} className="text-destructive">
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </>
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
      <div className="h-full overflow-y-auto p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <LiteModeBackButton />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Domains</h1>
              <p className="text-sm text-muted-foreground">
                Manage domains, track DNS status, and issue certificates
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canManageFolders && createFolderAction
                ? [
                    {
                      label: "Add Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: createFolderAction,
                    },
                  ]
                : []),
              ...(canCreateDomain && domainsAvailable
                ? [
                    {
                      label: "Add Domain",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setAddDialogOpen(true),
                    },
                  ]
                : []),
            ]}
          >
            {canManageFolders && (
              <Button variant="outline" onClick={() => createFolderAction?.()}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {canCreateDomain && domainsAvailable && (
              <Button onClick={() => setAddDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Domain
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        <FolderedResourceList<Domain>
          resourceType="domain"
          realtimeChannel="domain.changed"
          resources={filteredDomains}
          columns={domainColumns}
          search={{
            placeholder: "Search domains...",
            search,
            onSearchChange: setSearch,
            hasActiveFilters,
            onReset: () => {
              setSearch("");
              setStatusFilter("all");
            },
            filters: (
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as DnsStatus | "all")}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="DNS Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="valid">Valid</SelectItem>
                  <SelectItem value="invalid">Invalid</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            ),
          }}
          loading={isLoading}
          loadingLabel="Loading domains..."
          emptyState={
            <EmptyState
              message={
                domainsAvailable ? "No domains." : "Cloudflare DNS integration is not configured."
              }
              actionLabel={canCreateDomain && domainsAvailable ? "Add one" : undefined}
              onAction={
                canCreateDomain && domainsAvailable ? () => setAddDialogOpen(true) : undefined
              }
              hasActiveFilters={hasActiveFilters}
              onReset={() => {
                setSearch("");
                setStatusFilter("all");
              }}
            />
          }
          minWidth={800}
          canManageFolders={canManageFolders}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(domain) => domain.domain}
          onItemClick={(domain) => openDetail(domain.id)}
          onRefresh={loadDomains}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />

        <AddDomainDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onCreated={loadDomains}
        />
        <DomainDetailDialog
          domainId={detailId}
          open={detailOpen}
          onOpenChange={setDetailOpen}
          onUpdated={loadDomains}
        />
      </div>
    </PageTransition>
  );
}
