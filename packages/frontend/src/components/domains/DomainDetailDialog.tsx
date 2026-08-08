import { ExternalLink, Lock, RefreshCw, Shield } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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

function RecordRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <tr>
      <td className="py-1 pr-3 text-muted-foreground align-top whitespace-nowrap">{label}</td>
      <td className="py-1 font-mono break-all">{values.join(", ")}</td>
    </tr>
  );
}

function DnsRecordsTable({ records }: { records: DnsRecords }) {
  const hasAny =
    records.a.length > 0 ||
    records.aaaa.length > 0 ||
    records.cname.length > 0 ||
    records.caa.length > 0 ||
    records.mx.length > 0 ||
    records.txt.length > 0;

  if (!hasAny) return <p className="text-xs text-muted-foreground">No DNS records found</p>;

  return (
    <table className="w-full text-xs">
      <tbody>
        <RecordRow label="A" values={records.a} />
        <RecordRow label="AAAA" values={records.aaaa} />
        <RecordRow label="CNAME" values={records.cname} />
        <RecordRow
          label="CAA"
          values={records.caa.map((r) => r.issue || r.issuewild || "").filter(Boolean)}
        />
        <RecordRow label="MX" values={records.mx.map((r) => `${r.priority} ${r.exchange}`)} />
        <RecordRow label="TXT" values={records.txt.map((r) => r.join("")).slice(0, 3)} />
      </tbody>
    </table>
  );
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

            {/* DNS */}
            <div className="border border-border bg-card">
              <div className="flex items-center justify-between p-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">DNS</span>
                  <DnsStatusBadge status={domain.dnsStatus} />
                </div>
                <Button size="sm" variant="ghost" onClick={handleCheckDns} disabled={isCheckingDns}>
                  <RefreshCw className={`h-3.5 w-3.5 ${isCheckingDns ? "animate-spin" : ""}`} />
                  {isCheckingDns ? "Checking..." : "Check"}
                </Button>
              </div>
              <div className="p-3">
                {domain.dnsRecords ? (
                  <DnsRecordsTable records={domain.dnsRecords} />
                ) : (
                  <p className="text-xs text-muted-foreground">Run a DNS check to see records</p>
                )}
              </div>
            </div>

            {/* Usage */}
            <div className="border border-border bg-card">
              <div className="p-3 border-b border-border">
                <span className="text-sm font-medium">Usage</span>
              </div>
              <div className="p-3 space-y-3">
                {domain.usage.proxyHosts.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">
                      Proxy Hosts
                    </p>
                    {domain.usage.proxyHosts.map((ph) => (
                      <Link
                        key={ph.id}
                        to={proxyHostRoute(ph.slug)}
                        onClick={() => handleClose(false)}
                        className="flex items-center gap-2 py-1 text-sm hover:underline"
                      >
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{ph.domainNames[0]}</span>
                        {!ph.enabled && (
                          <Badge variant="secondary" size="inline">
                            Off
                          </Badge>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
                {domain.usage.sslCertificates.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">
                      SSL Certificates
                    </p>
                    {domain.usage.sslCertificates.map((cert) => (
                      <div key={cert.id} className="flex items-center gap-2 py-1 text-sm">
                        <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate">{cert.domainNames[0]}</span>
                        <Badge
                          variant={cert.status === "active" ? "success" : "secondary"}
                          size="inline"
                        >
                          {cert.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
                {domain.usage.proxyHosts.length === 0 &&
                  domain.usage.sslCertificates.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Not used by any proxy hosts or certificates
                    </p>
                  )}
              </div>
            </div>
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
