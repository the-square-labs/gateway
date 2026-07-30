import { ClipboardCopy, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailRow } from "@/components/common/DetailRow";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";
import type { LicenseStatus, LicenseStatusView, LicenseTier } from "@/types";

interface LicenseSectionProps {
  canManage: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function tierLabel(tier: LicenseTier): string {
  if (tier === "community") return "Community";
  if (tier === "homelab") return "Homelab";
  return "Enterprise";
}

function tierIconSrc(tier: LicenseTier): string {
  return `/license/wiolett-gw-${tier}.png`;
}

function statusLabel(status: LicenseStatus): string {
  switch (status) {
    case "community":
      return "Community";
    case "valid":
      return "Licensed";
    case "valid_with_warning":
      return "Licensed with warning";
    case "unreachable_grace_expired":
      return "Grace expired";
    case "invalid":
      return "Invalid";
    case "expired":
      return "Expired";
    case "revoked":
      return "Revoked";
    case "replaced":
      return "Replaced";
  }
}

function statusVariant(status: LicenseStatus): "secondary" | "success" | "warning" | "destructive" {
  if (status === "valid") return "success";
  if (status === "community") return "secondary";
  if (status === "valid_with_warning") return "warning";
  return "destructive";
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("Copied to clipboard"),
    () => toast.error("Failed to copy")
  );
}

function InstallationIdValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 font-mono hover:text-primary cursor-pointer"
      onClick={() => copyToClipboard(value)}
    >
      {value.slice(0, 12)}...
      <ClipboardCopy className="h-3 w-3" />
    </button>
  );
}

function LicenseKeyValue({ last4 }: { last4: string | null }) {
  return <span className="font-mono text-xs">WLT-GW-...-{last4 ?? "????"}</span>;
}

function LicenseSummary({ status }: { status: LicenseStatusView }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border p-4">
      <div className="flex min-w-0 items-center gap-4">
        <img src={tierIconSrc(status.tier)} alt={tierLabel(status.tier)} className="h-10 w-10" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{tierLabel(status.tier)}</p>
          <p className="truncate text-xs text-muted-foreground mt-0.5">
            {status.hasKey
              ? `Licensed to ${status.licenseName ?? status.installationName}`
              : "Community license"}
          </p>
        </div>
      </div>
      <Badge className="shrink-0 uppercase" variant={statusVariant(status.status)} size="inline">
        {statusLabel(status.status)}
      </Badge>
    </div>
  );
}

export function LicenseSection({ canManage }: LicenseSectionProps) {
  const [status, setStatus] = useState<LicenseStatusView | null>(
    () => api.getCached<LicenseStatusView>("settings:license-status") ?? null
  );
  const [loading, setLoading] = useState(
    () => api.getCached<LicenseStatusView>("settings:license-status") === undefined
  );
  const [checking, setChecking] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.getLicenseStatus();
      api.setCache("settings:license-status", data);
      setStatus(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load license status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      const updated = await api.checkLicense();
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      toast.success("License checked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check license");
    } finally {
      setChecking(false);
    }
  };

  const handleActivate = async () => {
    if (!licenseKey.trim()) return;
    setSaving(true);
    try {
      const updated = await api.activateLicense(licenseKey.trim());
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      setLicenseKey("");
      setDialogOpen(false);
      if (updated.status === "valid") {
        toast.success("License activated");
      } else {
        toast.error(updated.errorMessage ?? "License was not accepted");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to activate license");
    } finally {
      setSaving(false);
    }
  };

  const handleDeactivate = async () => {
    const ok = await confirm({
      title: "Deactivate License",
      description: "Remove the installed license key from this Gateway?",
      confirmLabel: "Deactivate",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const updated = await api.clearLicenseKey();
      api.setCache("settings:license-status", updated);
      setStatus(updated);
      toast.success("License deactivated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to deactivate license");
    }
  };

  if (loading || !status) {
    return (
      <PanelShell
        title="License"
        description="Loading license status"
        actions={<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      />
    );
  }

  return (
    <>
      <PanelShell
        title="License"
        description="Current Gateway license and activation state"
        actions={
          canManage ? (
            <Button onClick={() => setDialogOpen(true)}>
              <KeyRound className="h-4 w-4" />
              Update license
            </Button>
          ) : null
        }
      >
        <LicenseSummary status={status} />

        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          <DetailRow
            label="Installation ID"
            value={<InstallationIdValue value={status.installationId} />}
          />
          <DetailRow
            label="Expires"
            value={
              <Badge variant="secondary" className="uppercase">
                {status.expiresAt ? formatDate(status.expiresAt) : "Perpetual"}
              </Badge>
            }
          />
          <DetailRow label="Last checked" value={formatDate(status.lastCheckedAt)} />
        </div>
      </PanelShell>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update License</DialogTitle>
          </DialogHeader>
          {status.hasKey && (
            <div className="space-y-3">
              <div className="border border-border bg-card">
                <LicenseSummary status={status} />
                <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
                  <DetailRow label="Key" value={<LicenseKeyValue last4={status.keyLast4} />} />
                  <DetailRow
                    label="Installation ID"
                    value={<InstallationIdValue value={status.installationId} />}
                  />
                  <DetailRow
                    label="Expires"
                    value={
                      <Badge variant="secondary" className="uppercase">
                        {status.expiresAt ? formatDate(status.expiresAt) : "Perpetual"}
                      </Badge>
                    }
                  />
                  <DetailRow label="Last checked" value={formatDate(status.lastCheckedAt)} />
                  <DetailRow label="Last valid" value={formatDate(status.lastValidAt)} />
                  {status.graceUntil && (
                    <DetailRow label="Grace until" value={formatDate(status.graceUntil)} />
                  )}
                  {status.activeInstallationName && (
                    <DetailRow label="Server name" value={status.activeInstallationName} />
                  )}
                  {status.activeInstallationId && (
                    <DetailRow
                      label="Server ID"
                      value={<InstallationIdValue value={status.activeInstallationId} />}
                    />
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={handleCheck} disabled={checking}>
                  {checking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Check
                </Button>
                <Button variant="destructive" onClick={handleDeactivate}>
                  <Trash2 className="h-4 w-4" />
                  Deactivate
                </Button>
              </div>
            </div>
          )}
          {!status.hasKey && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="license-key">
                  License key
                </label>
                <Input
                  id="license-key"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="WLT-GW-XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button onClick={handleActivate} disabled={!licenseKey.trim() || saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Activate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
