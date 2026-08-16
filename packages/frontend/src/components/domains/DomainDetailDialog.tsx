import { ArrowRight, ExternalLink, Loader2, Lock, RefreshCw, Truck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { SimpleTable } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { proxyHostRoute } from "@/lib/resource-routes";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  DnsRecords,
  DomainCloudflareMigrationStatus,
  DomainIngressMigrationImpact,
  DomainNginxNodeOptions,
  DomainWithUsage,
  ResolveCloudflareMigrationRequest,
} from "@/types";
import { DnsStatusBadge } from "./DnsStatusBadge";
import { getDomainPermissions } from "./domain-permissions";

interface DomainDetailDialogProps {
  domainId: string | null;
  open: boolean;
  initialView?: "details" | "ingress-migration";
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

function dnsRows(records: DnsRecords) {
  return [
    { type: "A", values: records.a },
    { type: "AAAA", values: records.aaaa },
    { type: "CNAME", values: records.cname },
    {
      type: "CAA",
      values: records.caa.map((record) => {
        const tag = record.issue ? "issue" : "issuewild";
        return `${record.critical} ${tag} ${record.issue ?? record.issuewild ?? ""}`.trim();
      }),
    },
    { type: "MX", values: records.mx.map((record) => `${record.priority} ${record.exchange}`) },
    { type: "TXT", values: records.txt.map((record) => record.join("")) },
  ].filter((row) => row.values.length > 0);
}

const CLOUDFLARE_MIGRATION_LABELS: Record<DomainCloudflareMigrationStatus, string> = {
  pending: "Checking",
  migrated: "Migrated",
  zone_unavailable: "Zone unavailable",
  zone_ambiguous: "Multiple matching zones",
  ingress_unavailable: "Ingress unavailable",
  dns_conflict: "DNS records conflict",
  ignored: "External DNS retained",
  error: "Migration failed",
};

type UsageRow =
  | { key: string; type: "Route"; value: DomainWithUsage["usage"]["proxyHosts"][number] }
  | {
      key: string;
      type: "SSL Certificate";
      value: DomainWithUsage["usage"]["sslCertificates"][number];
    };

type IngressMigrationImpactRow =
  | { key: string; type: "Domain"; target: string }
  | { key: string; type: "Route"; target: string };

function cloudflareTargetDescription(domain: DomainWithUsage): string | undefined {
  const effectiveAddress = domain.nginxNode?.effectiveAddress;
  if (domain.nginxNode && !effectiveAddress) return "Assigned node has no available public address";
  if (
    effectiveAddress &&
    (domain.dnsTargetIps.length !== 1 || domain.dnsTargetIps[0] !== effectiveAddress)
  ) {
    return `Node public address is ${effectiveAddress}; the tracked origin needs reconciliation`;
  }
  return undefined;
}

export function DomainDetailDialog({
  domainId,
  open,
  initialView = "details",
  onOpenChange,
  onUpdated,
}: DomainDetailDialogProps) {
  const { hasScope } = useAuthStore();
  const { canEditDomain: canEdit } = getDomainPermissions(hasScope, domainId);
  const canEditDns = canEdit;
  const [domain, setDomain] = useState<DomainWithUsage | null>(null);
  const [description, setDescription] = useState("");
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [isUpdatingProxied, setIsUpdatingProxied] = useState(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [nodeOptions, setNodeOptions] = useState<DomainNginxNodeOptions | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [ingressMigrationOpen, setIngressMigrationOpen] = useState(false);
  const [ingressMigrationNodes, setIngressMigrationNodes] = useState<DomainNginxNodeOptions | null>(
    null
  );
  const [ingressMigrationTargetNodeId, setIngressMigrationTargetNodeId] = useState("");
  const [ingressMigrationImpact, setIngressMigrationImpact] =
    useState<DomainIngressMigrationImpact | null>(null);
  const [isLoadingIngressMigration, setIsLoadingIngressMigration] = useState(false);
  const [isMigratingIngress, setIsMigratingIngress] = useState(false);
  const loadedDomainIdRef = useRef<string | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  const initialIngressMigrationStartedRef = useRef(false);
  onOpenChangeRef.current = onOpenChange;

  const loadDomain = useCallback(async () => {
    if (!domainId || !open) return;
    const initialLoad = loadedDomainIdRef.current !== domainId;
    try {
      const d = await api.getDomain(domainId);
      loadedDomainIdRef.current = domainId;
      setDomain(d);
      setDescription(d.description || "");
    } catch {
      toast.error("Failed to load domain");
      if (initialLoad) onOpenChangeRef.current(false);
    }
  }, [domainId, open]);

  useEffect(() => {
    void loadDomain();
  }, [loadDomain]);

  useRealtime(open ? "domain.changed" : null, (payload) => {
    const event = payload as { id?: string; action?: string } | undefined;
    if (!domainId || (event?.id && event.id !== domainId)) return;
    if (event?.action === "deleted") {
      onOpenChange(false);
      onUpdated();
      return;
    }
    void loadDomain();
    onUpdated();
  });

  useRealtime(open ? "proxy.host.changed" : null, () => {
    void loadDomain();
    onUpdated();
  });

  useRealtime(open ? "ssl.cert.changed" : null, () => {
    void loadDomain();
    onUpdated();
  });

  const saveIfChanged = async () => {
    if (!domain) return;
    const newDesc = description.trim() || null;
    if (newDesc === (domain.description || null)) return;
    try {
      await api.updateDomain(domain.id, { description: newDesc });
      onUpdated();
    } catch {
      // silent
    }
  };

  const handleClose = (v: boolean) => {
    if (!v) saveIfChanged();
    onOpenChange(v);
  };

  const handleCheckDns = async () => {
    if (!domain) return;
    setIsCheckingDns(true);
    try {
      const updated = await api.checkDomainDns(domain.id);
      setDomain({ ...domain, ...updated, usage: domain.usage });
      toast.success("DNS check complete");
      onUpdated();
    } catch {
      toast.error("DNS check failed");
    } finally {
      setIsCheckingDns(false);
    }
  };

  const handleProxiedChange = async (proxied: boolean) => {
    if (!domain || !canEditDns || proxied === domain.dnsProxied) return;
    setIsUpdatingProxied(true);
    try {
      const updated = await api.updateDomain(domain.id, { proxied });
      setDomain({ ...domain, ...updated, usage: domain.usage });
      toast.success(proxied ? "Cloudflare proxy enabled" : "Cloudflare proxy disabled");
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update Cloudflare proxy");
    } finally {
      setIsUpdatingProxied(false);
    }
  };

  const openConflictResolution = async () => {
    if (!domain) return;
    try {
      const options = await api.listDomainNginxNodes();
      setNodeOptions(options);
      const selected = options.eligibleNodes.some((node) => node.id === domain.nginxNodeId)
        ? domain.nginxNodeId
        : options.eligibleNodes[0]?.id;
      setSelectedNodeId(selected || "");
      setResolutionOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load Ingress nodes");
    }
  };

  const resolveMigration = async (input: ResolveCloudflareMigrationRequest) => {
    if (!domain) return;
    setIsResolving(true);
    try {
      const updated = await api.resolveDomainCloudflareMigration(domain.id, input);
      setDomain(updated);
      setDescription(updated.description || "");
      onUpdated();
      if (updated.dnsProvider === "cloudflare" || input.action === "keep_external") {
        setResolutionOpen(false);
      }
      toast.success(
        updated.dnsProvider === "cloudflare"
          ? "Domain migrated to Cloudflare"
          : input.action === "keep_external"
            ? "External DNS retained"
            : "Cloudflare migration checked"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve DNS conflict");
    } finally {
      setIsResolving(false);
    }
  };

  const handleUpdateDns = async () => {
    const selectedNode = nodeOptions?.eligibleNodes.find((node) => node.id === selectedNodeId);
    if (!domain || !selectedNode) return;
    const approved = await confirm({
      title: "Update Cloudflare DNS?",
      description: `Change ${domain.domain} from ${
        [...(domain.dnsRecords?.a ?? []), ...(domain.dnsRecords?.aaaa ?? [])].join(", ") ||
        "no address record"
      } to ${selectedNode.effectiveAddress} and migrate it to Gateway management?`,
      confirmLabel: "Update DNS and migrate",
      variant: "default",
    });
    if (approved) {
      await resolveMigration({ action: "update_dns", nginxNodeId: selectedNode.id });
    }
  };

  const handleKeepExternal = async () => {
    if (!domain) return;
    const approved = await confirm({
      title: "Keep external DNS?",
      description: `Stop trying to migrate ${domain.domain} to Cloudflare. Gateway will continue checking its external DNS health.`,
      confirmLabel: "Keep external DNS",
      variant: "default",
    });
    if (approved) await resolveMigration({ action: "keep_external" });
  };

  const openIngressMigration = useCallback(async () => {
    if (!domain) return;
    setIsLoadingIngressMigration(true);
    try {
      const options = await api.listDomainNginxNodes();
      const pendingTargetId = domain.ingressMigrationId ? domain.nginxNodeId : null;
      const target = pendingTargetId
        ? options.eligibleNodes.find((node) => node.id === pendingTargetId)
        : options.eligibleNodes.find((node) => node.id !== domain.nginxNodeId);
      if (!target) {
        toast.error("No other eligible Ingress node is available");
        if (initialView === "ingress-migration") onOpenChange(false);
        return;
      }
      setIngressMigrationNodes(options);
      setIngressMigrationTargetNodeId(target.id);
      setIngressMigrationOpen(true);
      setIngressMigrationImpact(await api.previewDomainIngressMigration(domain.id, target.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to prepare ingress migration");
      if (initialView === "ingress-migration") onOpenChange(false);
    } finally {
      setIsLoadingIngressMigration(false);
    }
  }, [domain, initialView, onOpenChange]);

  useEffect(() => {
    if (!open) {
      initialIngressMigrationStartedRef.current = false;
      return;
    }
    if (
      initialView !== "ingress-migration" ||
      !domain ||
      initialIngressMigrationStartedRef.current
    ) {
      return;
    }
    initialIngressMigrationStartedRef.current = true;
    void openIngressMigration();
  }, [domain, initialView, open, openIngressMigration]);

  const changeIngressMigrationTarget = async (targetNodeId: string) => {
    if (!domain) return;
    setIngressMigrationTargetNodeId(targetNodeId);
    setIsLoadingIngressMigration(true);
    try {
      setIngressMigrationImpact(await api.previewDomainIngressMigration(domain.id, targetNodeId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to preview ingress migration");
    } finally {
      setIsLoadingIngressMigration(false);
    }
  };

  const handleMigrateIngress = async () => {
    if (!domain || !ingressMigrationTargetNodeId) return;
    setIsMigratingIngress(true);
    try {
      const result = await api.migrateDomainIngress(domain.id, ingressMigrationTargetNodeId);
      setIngressMigrationImpact(result);
      await loadDomain();
      onUpdated();
      if (result.status === "completed") {
        setIngressMigrationOpen(false);
        if (initialView === "ingress-migration") onOpenChange(false);
        toast.success("Ingress migration completed");
      } else if (result.status === "waiting_dns") {
        toast.info("Update external DNS, then complete the migration");
      } else {
        toast.warning("Source cleanup is pending");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ingress migration failed");
    } finally {
      setIsMigratingIngress(false);
    }
  };

  const selectedNode = nodeOptions?.eligibleNodes.find((node) => node.id === selectedNodeId);
  const ingressMigrationTarget = ingressMigrationNodes?.eligibleNodes.find(
    (node) => node.id === ingressMigrationTargetNodeId
  );
  const ingressMigrationDnsBlocked = Boolean(
    ingressMigrationImpact?.status === "ready" &&
      ingressMigrationImpact.requiresExternalDnsBeforeMove &&
      ingressMigrationImpact.domains.some(
        (item) => item.dnsProvider === "external" && item.dnsStatus !== "valid"
      )
  );
  const currentAddress = domain
    ? [...(domain.dnsRecords?.a ?? []), ...(domain.dnsRecords?.aaaa ?? [])].join(", ") ||
      "No address record"
    : "";
  const detailsReady = Boolean(domain && domainId && loadedDomainIdRef.current === domainId);

  return (
    <>
      <Dialog
        open={
          open &&
          detailsReady &&
          initialView === "details" &&
          !resolutionOpen &&
          !ingressMigrationOpen
        }
        onOpenChange={handleClose}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{domain?.domain}</DialogTitle>
            <DialogDescription>
              {domain?.lastDnsCheckAt
                ? `Last checked ${formatRelativeDate(domain.lastDnsCheckAt)}`
                : "DNS not checked yet"}
            </DialogDescription>
          </DialogHeader>

          {domain ? (
            <div className="space-y-4">
              {/* Description */}
              {canEdit && (
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              )}
              {!canEdit && domain.description && (
                <p className="text-sm text-muted-foreground">{domain.description}</p>
              )}

              {domain.dnsProvider === "cloudflare" && (
                <div className="border border-border bg-card">
                  <SettingsControlRow title="Proxied" description="Use Cloudflare proxy">
                    <Switch
                      checked={!!domain.dnsProxied}
                      onChange={handleProxiedChange}
                      disabled={!canEditDns || isUpdatingProxied}
                    />
                  </SettingsControlRow>
                </div>
              )}

              <PanelShell title="DNS Management">
                <SettingsControlRow title="Provider">
                  <span className="text-right text-sm">
                    {domain.dnsProvider === "cloudflare" ? "Cloudflare" : "External DNS"}
                  </span>
                </SettingsControlRow>
                {domain.dnsProvider === "legacy" && domain.cloudflareMigrationStatus && (
                  <SettingsControlRow
                    title="Cloudflare migration"
                    description={
                      domain.cloudflareMigrationCheckedAt
                        ? `Last checked ${formatRelativeDate(domain.cloudflareMigrationCheckedAt)}`
                        : undefined
                    }
                  >
                    {domain.cloudflareMigrationStatus === "dns_conflict" && canEdit ? (
                      <Button
                        variant="link"
                        className="h-auto p-0"
                        onClick={openConflictResolution}
                      >
                        Resolve conflict
                        <ArrowRight />
                      </Button>
                    ) : (
                      <span className="text-right text-sm">
                        {CLOUDFLARE_MIGRATION_LABELS[domain.cloudflareMigrationStatus]}
                      </span>
                    )}
                  </SettingsControlRow>
                )}
              </PanelShell>

              <PanelShell
                title={
                  <div className="flex items-center gap-2">
                    <span>DNS</span>
                    <DnsStatusBadge status={domain.dnsStatus} />
                  </div>
                }
                actions={
                  <Button onClick={handleCheckDns} disabled={isCheckingDns}>
                    <RefreshCw className={`h-3.5 w-3.5 ${isCheckingDns ? "animate-spin" : ""}`} />
                    {isCheckingDns ? "Checking..." : "Check"}
                  </Button>
                }
              >
                {domain.dnsRecords && dnsRows(domain.dnsRecords).length > 0 ? (
                  dnsRows(domain.dnsRecords).map((row) => (
                    <SettingsControlRow
                      key={row.type}
                      title={row.type}
                      className="sm:grid-cols-[minmax(5rem,8rem)_minmax(0,1fr)]"
                      controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                    >
                      <span className="min-w-0 max-w-full break-all text-right font-mono text-xs">
                        {row.values.join(", ")}
                      </span>
                    </SettingsControlRow>
                  ))
                ) : (
                  <p className="px-4 py-3 text-xs text-muted-foreground">
                    {domain.dnsRecords ? "No DNS records found" : "Run a DNS check to see records"}
                  </p>
                )}
              </PanelShell>

              {domain.dnsProvider === "cloudflare" && domain.dnsProxied && (
                <PanelShell title="Cloudflare Target">
                  <SettingsControlRow title="Ingress node">
                    <span className="min-w-0 truncate text-right text-sm">
                      {domain.nginxNode
                        ? domain.nginxNode.displayName || domain.nginxNode.hostname
                        : "Not assigned"}
                    </span>
                  </SettingsControlRow>
                  <SettingsControlRow
                    title="IP address"
                    description={cloudflareTargetDescription(domain)}
                    controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                  >
                    <span className="min-w-0 max-w-full break-all text-right font-mono text-xs">
                      {domain.dnsTargetIps.length > 0
                        ? domain.dnsTargetIps.join(", ")
                        : "Not assigned"}
                    </span>
                  </SettingsControlRow>
                </PanelShell>
              )}

              <PanelShell title="Usage" bodyClassName="min-w-0">
                <SimpleTable<UsageRow>
                  rows={[
                    ...domain.usage.proxyHosts.map(
                      (value): UsageRow => ({ key: `proxy-${value.id}`, type: "Route", value })
                    ),
                    ...domain.usage.sslCertificates.map(
                      (value): UsageRow => ({
                        key: `certificate-${value.id}`,
                        type: "SSL Certificate",
                        value,
                      })
                    ),
                  ]}
                  columns={[
                    {
                      id: "type",
                      header: "Type",
                      cellClassName: "whitespace-nowrap text-muted-foreground",
                      render: (row) => row.type,
                    },
                    {
                      id: "target",
                      header: "Target",
                      render: (row) =>
                        row.type === "Route" ? (
                          <Link
                            to={proxyHostRoute(row.value.slug)}
                            onClick={() => handleClose(false)}
                            className="flex min-w-0 items-center gap-2 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{row.value.domainNames[0]}</span>
                            {!row.value.enabled && (
                              <Badge variant="secondary" size="inline">
                                Off
                              </Badge>
                            )}
                          </Link>
                        ) : (
                          <div className="flex min-w-0 items-center gap-2">
                            <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{row.value.domainNames[0]}</span>
                            <Badge
                              variant={row.value.status === "active" ? "success" : "secondary"}
                              size="inline"
                            >
                              {row.value.status}
                            </Badge>
                          </div>
                        ),
                    },
                  ]}
                  getRowKey={(row) => row.key}
                  emptyMessage="Not used by any routes or certificates"
                />
              </PanelShell>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={resolutionOpen} onOpenChange={setResolutionOpen}>
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Resolve Cloudflare DNS conflict</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <PanelShell title="DNS conflict">
              <div className="divide-y divide-border">
                <DetailRow
                  label="Current DNS"
                  value={<span className="font-mono text-xs">{currentAddress}</span>}
                />
                <DetailRow
                  label="Required target"
                  value={
                    <span className="font-mono text-xs">
                      {selectedNode?.effectiveAddress || "Select a node"}
                    </span>
                  }
                />
              </div>
            </PanelShell>

            <PanelShell title="Routing">
              <SettingsControlRow title="Ingress node" description="Public ingress for this domain">
                <Select
                  value={selectedNodeId}
                  onValueChange={setSelectedNodeId}
                  disabled={isResolving}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue>
                      {selectedNode?.displayName || selectedNode?.hostname || "Select a node"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {nodeOptions?.eligibleNodes.map((node) => (
                      <SelectItem key={node.id} value={node.id}>
                        {node.displayName || node.hostname} · {node.effectiveAddress}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </PanelShell>

            <PanelShell title="Other actions">
              <SettingsControlRow
                title="Retry"
                description="Recheck Cloudflare after correcting DNS manually"
              >
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={isResolving}
                  onClick={() => resolveMigration({ action: "retry" })}
                >
                  Retry <ArrowRight />
                </Button>
              </SettingsControlRow>
              <SettingsControlRow
                title="Keep external DNS"
                description="Stop automatic Cloudflare migration for this domain"
              >
                <Button
                  variant="link"
                  className="h-auto p-0"
                  disabled={isResolving}
                  onClick={handleKeepExternal}
                >
                  Keep external DNS <ArrowRight />
                </Button>
              </SettingsControlRow>
            </PanelShell>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResolutionOpen(false)}
              disabled={isResolving}
            >
              Cancel
            </Button>
            <Button onClick={handleUpdateDns} disabled={!selectedNode || isResolving}>
              Update DNS and migrate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ingressMigrationOpen}
        onOpenChange={(nextOpen) => {
          if (isMigratingIngress) return;
          setIngressMigrationOpen(nextOpen);
          if (!nextOpen && initialView === "ingress-migration") onOpenChange(false);
        }}
      >
        <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Move ingress</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <PanelShell title="Routing">
              <SettingsControlRow title="Source node">
                <span className="text-right text-sm">
                  {ingressMigrationImpact?.sourceNode.displayName ||
                    ingressMigrationImpact?.sourceNode.hostname ||
                    domain?.nginxNode?.displayName ||
                    domain?.nginxNode?.hostname ||
                    "Not assigned"}
                </span>
              </SettingsControlRow>
              <SettingsControlRow title="Target node" description="New public ingress">
                <Select
                  value={ingressMigrationTargetNodeId}
                  onValueChange={changeIngressMigrationTarget}
                  disabled={isMigratingIngress || Boolean(domain?.ingressMigrationId)}
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue>
                      {ingressMigrationTarget?.displayName ||
                        ingressMigrationTarget?.hostname ||
                        "Select a node"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ingressMigrationNodes?.eligibleNodes
                      .filter(
                        (node) =>
                          node.id !== domain?.nginxNodeId || Boolean(domain?.ingressMigrationId)
                      )
                      .map((node) => (
                        <SelectItem key={node.id} value={node.id}>
                          {node.displayName || node.hostname} · {node.effectiveAddress}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </SettingsControlRow>
            </PanelShell>

            {ingressMigrationImpact ? (
              <PanelShell title="Impact" bodyClassName="min-w-0">
                <SimpleTable<IngressMigrationImpactRow>
                  rows={[
                    ...ingressMigrationImpact.domains.map(
                      (item): IngressMigrationImpactRow => ({
                        key: `domain-${item.id}`,
                        type: "Domain",
                        target: item.domain,
                      })
                    ),
                    ...ingressMigrationImpact.proxyHosts.map(
                      (item): IngressMigrationImpactRow => ({
                        key: `proxy-${item.id}`,
                        type: "Route",
                        target: item.domainNames[0] || item.slug,
                      })
                    ),
                  ]}
                  columns={[
                    {
                      id: "type",
                      header: "Type",
                      cellClassName: "whitespace-nowrap text-muted-foreground",
                      render: (row) => row.type,
                    },
                    { id: "target", header: "Target", render: (row) => row.target },
                  ]}
                  getRowKey={(row) => row.key}
                  emptyMessage="No linked routes"
                />
              </PanelShell>
            ) : null}

            {ingressMigrationImpact?.domains.some((item) => item.dnsProvider === "external") ? (
              <PanelShell title="External DNS">
                {ingressMigrationImpact.domains
                  .filter((item) => item.dnsProvider === "external")
                  .map((item) => (
                    <SettingsControlRow
                      key={item.id}
                      title={item.domain}
                      description={
                        item.dnsStatus === "valid"
                          ? "Ready"
                          : ingressMigrationImpact.requiresExternalDnsBeforeMove
                            ? "Point DNS to the target before starting"
                            : "Point DNS to the target before completing"
                      }
                      controlsClassName="min-w-0 sm:w-full sm:max-w-none"
                    >
                      <span className="break-all text-right font-mono text-xs">
                        {ingressMigrationImpact.targetIps.join(", ")}
                      </span>
                    </SettingsControlRow>
                  ))}
              </PanelShell>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIngressMigrationOpen(false);
                if (initialView === "ingress-migration") onOpenChange(false);
              }}
              disabled={isMigratingIngress}
            >
              Cancel
            </Button>
            <Button
              onClick={handleMigrateIngress}
              disabled={
                !ingressMigrationImpact ||
                ingressMigrationDnsBlocked ||
                isLoadingIngressMigration ||
                isMigratingIngress
              }
            >
              {isMigratingIngress || isLoadingIngressMigration ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Truck className="h-4 w-4" />
              )}
              {ingressMigrationImpact?.status === "waiting_dns"
                ? "Check DNS and complete"
                : ingressMigrationImpact?.status === "cleanup_pending"
                  ? "Retry cleanup"
                  : "Move ingress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
