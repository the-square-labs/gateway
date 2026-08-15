import { ExternalLink, Lock, RefreshCw, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { proxyHostRoute } from "@/lib/resource-routes";
import { formatRelativeDate } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DnsRecords, DomainWithUsage } from "@/types";
import { DnsStatusBadge } from "./DnsStatusBadge";
import { getDomainPermissions } from "./domain-permissions";

interface DomainDetailDialogProps {
  domainId: string | null;
  open: boolean;
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

type UsageRow =
  | { key: string; type: "Proxy Host"; value: DomainWithUsage["usage"]["proxyHosts"][number] }
  | {
      key: string;
      type: "SSL Certificate";
      value: DomainWithUsage["usage"]["sslCertificates"][number];
    };

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
  onOpenChange,
  onUpdated,
}: DomainDetailDialogProps) {
  const { hasScope } = useAuthStore();
  const { canEditDomain: canEdit } = getDomainPermissions(hasScope);
  const canEditDns = canEdit;
  const canIssueCert = canEdit && hasScope("ssl:cert:issue");
  const [domain, setDomain] = useState<DomainWithUsage | null>(null);
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingDns, setIsCheckingDns] = useState(false);
  const [isIssuingCert, setIsIssuingCert] = useState(false);
  const [isUpdatingProxied, setIsUpdatingProxied] = useState(false);

  const loadDomain = useCallback(async () => {
    if (!domainId || !open) return;
    setIsLoading(true);
    try {
      const d = await api.getDomain(domainId);
      setDomain(d);
      setDescription(d.description || "");
    } catch {
      toast.error("Failed to load domain");
    } finally {
      setIsLoading(false);
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

  const handleIssueCert = async () => {
    if (!domain) return;
    setIsIssuingCert(true);
    try {
      await api.issueDomainCert(domain.id);
      toast.success("Certificate issued");
      await loadDomain();
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue certificate");
    } finally {
      setIsIssuingCert(false);
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{domain?.domain || "Loading..."}</DialogTitle>
          <DialogDescription>
            {domain?.lastDnsCheckAt
              ? `Last checked ${formatRelativeDate(domain.lastDnsCheckAt)}`
              : "DNS not checked yet"}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading domain details">
            <Skeleton className="h-10 w-full" />
            <div className="border border-border bg-card divide-y divide-border">
              {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex items-center justify-between gap-4 p-4">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-5 w-10" />
                </div>
              ))}
            </div>
          </div>
        ) : domain ? (
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

            <PanelShell
              title={
                <div className="flex items-center gap-2">
                  <span>DNS</span>
                  <DnsStatusBadge status={domain.dnsStatus} />
                </div>
              }
              actions={
                <Button size="sm" variant="ghost" onClick={handleCheckDns} disabled={isCheckingDns}>
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
                <SettingsControlRow title="Node">
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
                    (value): UsageRow => ({ key: `proxy-${value.id}`, type: "Proxy Host", value })
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
                      row.type === "Proxy Host" ? (
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
                emptyMessage="Not used by any proxy hosts or certificates"
              />
            </PanelShell>
          </div>
        ) : null}
        {domain && (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>
              Close
            </Button>
            {canIssueCert &&
              !domain.dnsProxied &&
              domain.usage.sslCertificates.length === 0 &&
              domain.dnsStatus === "valid" && (
                <Button onClick={handleIssueCert} disabled={isIssuingCert}>
                  <Shield className="h-4 w-4" />
                  {isIssuingCert ? "Issuing..." : "Issue Let's Encrypt Certificate"}
                </Button>
              )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
