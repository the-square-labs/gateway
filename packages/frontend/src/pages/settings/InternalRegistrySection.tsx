import { HardDrive, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { DomainAutocompleteInput } from "@/components/domains/DomainAutocompleteInput";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import { formatBytes } from "@/lib/utils";
import { api } from "@/services/api";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type { DockerInternalRegistryState, Node, SSLCertificate } from "@/types";

interface InternalRegistrySectionProps {
  nodesList: Node[];
}

function certificateCoversHostname(certificate: SSLCertificate, hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || certificate.status !== "active") return false;
  if (certificate.notAfter && Date.parse(certificate.notAfter) <= Date.now()) return false;
  return certificate.domainNames.some((domain) => {
    const candidate = domain.trim().toLowerCase().replace(/\.$/, "");
    if (candidate === normalized) return true;
    if (!candidate.startsWith("*.")) return false;
    const suffix = candidate.slice(2);
    return (
      normalized.endsWith(`.${suffix}`) &&
      normalized.split(".").length === suffix.split(".").length + 1
    );
  });
}

export function InternalRegistrySection({ nodesList }: InternalRegistrySectionProps) {
  const [state, setState] = useState<DockerInternalRegistryState | null>(null);
  const [externalEnabled, setExternalEnabled] = useState(false);
  const [hostname, setHostname] = useState("");
  const [nginxNodeId, setNginxNodeId] = useState("");
  const [certificateId, setCertificateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [certificates, setCertificates] = useState<SSLCertificate[]>([]);

  const applyState = useCallback((next: DockerInternalRegistryState, syncForm = true) => {
    setState(next);
    if (!syncForm) return;
    setExternalEnabled(next.externalAccessEnabled);
    setHostname(next.externalHostname ?? "");
    setNginxNodeId(next.externalNginxNodeId ?? "");
    setCertificateId(next.externalCertificateId ?? "");
  }, []);

  useEffect(() => {
    void Promise.all([
      api.getDockerInternalRegistryState(),
      api.listSSLCertificates({ limit: 100, status: "active" }),
    ])
      .then(([next, certificateResponse]) => {
        applyState(next);
        setCertificates(certificateResponse.data ?? []);
      })
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to load internal registry")
      );
  }, [applyState]);

  const nginxNodes = useMemo(() => nodesList.filter((node) => node.type === "nginx"), [nodesList]);
  const matchingCertificates = useMemo(
    () => certificates.filter((certificate) => certificateCoversHostname(certificate, hostname)),
    [certificates, hostname]
  );
  const used = state?.storageUsedBytes ?? 0;
  const capacity = state?.storageCapacityBytes ?? null;
  const free = capacity === null ? null : Math.max(0, capacity - used);

  const save = async () => {
    if (!state) return;
    setSaving(true);
    try {
      const next = await api.updateDockerInternalRegistrySettings({
        externalAccessEnabled: externalEnabled,
        externalHostname: externalEnabled ? hostname.trim() || undefined : undefined,
        externalNginxNodeId: externalEnabled ? nginxNodeId || undefined : undefined,
        externalCertificateId: externalEnabled ? certificateId || undefined : undefined,
      });
      applyState(next);
      toast.success("Internal registry settings updated");
    } catch (error) {
      if (!handleLicenseApiError(error, "External internal registry access")) {
        toast.error(error instanceof Error ? error.message : "Failed to update internal registry");
      }
    } finally {
      setSaving(false);
    }
  };

  const dirty = Boolean(
    state &&
      (externalEnabled !== state.externalAccessEnabled ||
        (externalEnabled &&
          (hostname.trim() !== (state.externalHostname ?? "") ||
            nginxNodeId !== (state.externalNginxNodeId ?? "") ||
            certificateId !== (state.externalCertificateId ?? ""))))
  );

  const setExternalAccess = (enabled: boolean) => {
    if (enabled && !requireLicenseFeature("git-push-to-deploy", "External internal registry access")) {
      return;
    }
    setExternalEnabled(enabled);
    if (!enabled && state) {
      setHostname(state.externalHostname ?? "");
      setNginxNodeId(state.externalNginxNodeId ?? "");
      setCertificateId(state.externalCertificateId ?? "");
    }
  };

  useRealtime(
    "docker.registry.changed",
    (payload) => {
      const event = payload as { id?: string; action?: string } | undefined;
      if (event?.id !== "gateway-internal-registry") return;
      void api
        .getDockerInternalRegistryState()
        .then((next) => applyState(next, event.action === "settings" && !dirty))
        .catch(() => undefined);
    },
    {
      onReconnect: () => {
        void api
          .getDockerInternalRegistryState()
          .then((next) => applyState(next, !dirty))
          .catch(() => undefined);
      },
    }
  );

  return (
    <PanelShell
      title={
        <span className="flex items-center gap-2">
          <HardDrive className="h-4 w-4" />
          Internal Registry
          <Badge variant={state?.status === "ready" ? "success" : "warning"} size="inline">
            {state?.status?.replaceAll("_", " ") ?? "Loading"}
          </Badge>
          <Badge variant={state?.writable ? "default" : "secondary"} size="inline">
            {state?.writable ? "Writable" : "Read only"}
          </Badge>
        </span>
      }
      description={state?.lastError ?? "Managed registry for Git builds and runtime image pulls."}
      dirty={dirty}
      actions={
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void save()}
            disabled={
              !state ||
              saving ||
              !dirty ||
              (externalEnabled && (!hostname || !nginxNodeId || !certificateId))
            }
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <SettingsControlRow
        title="Storage backend"
        description="Artifacts are stored on the Gateway-managed registry volume."
      >
        <span className="text-sm">Local volume</span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Capacity"
        description="Registry data remains on the Gateway node volume."
      >
        <span className="text-right text-sm">
          {formatBytes(used)} used
          {capacity !== null ? ` · ${formatBytes(free ?? 0)} free of ${formatBytes(capacity)}` : ""}
        </span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Retention"
        description="Active, rollback, in-progress, and manual pins are never removed."
      >
        <span className="text-sm">3 successful artifacts + pins</span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Garbage collection"
        description="Expired unpinned manifests are removed on the maintenance schedule."
      >
        <span className="text-right text-sm text-muted-foreground">
          {state?.lastGcAt ? `Last ${new Date(state.lastGcAt).toLocaleString()}` : "Not run yet"}
          {state?.nextGcAt ? ` · Next ${new Date(state.nextGcAt).toLocaleString()}` : ""}
        </span>
      </SettingsControlRow>
      <SettingsControlRow
        title="Object storage"
        description="S3-compatible storage is planned but unavailable in this release."
      >
        <Badge variant="secondary">In development</Badge>
      </SettingsControlRow>
      <SettingsControlRow
        title={
          <span className="flex items-center gap-2">
            External access
            <Badge variant="default" size="inline">
              Business+
            </Badge>
          </span>
        }
        description="Internal builds and pulls keep working when this is disabled."
      >
        <Switch
          checked={externalEnabled}
          onChange={setExternalAccess}
          ariaLabel="External registry access"
        />
      </SettingsControlRow>
      {externalEnabled && (
        <>
          <SettingsControlRow
            title="External domain"
            description="Optional hostname for Docker clients outside the Gateway private transport."
          >
            <DomainAutocompleteInput
              value={hostname}
              onChange={setHostname}
              nginxNodeId={nginxNodeId || undefined}
              registeredOnly
              placeholder="registry.example.com"
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Ingress node"
            description="The selected Nginx node owns the public registry route."
          >
            <Select value={nginxNodeId} onValueChange={setNginxNodeId}>
              <SelectTrigger className="sm:w-72">
                <SelectValue placeholder="Select Nginx node" />
              </SelectTrigger>
              <SelectContent>
                {nginxNodes.map((node) => (
                  <SelectItem key={node.id} value={node.id}>
                    {node.displayName || node.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsControlRow>
          <SettingsControlRow
            title="TLS certificate"
            description="Certificate presented by the external registry endpoint."
          >
            <Select value={certificateId} onValueChange={setCertificateId}>
              <SelectTrigger className="sm:w-72">
                <SelectValue placeholder="Select certificate" />
              </SelectTrigger>
              <SelectContent>
                {matchingCertificates.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    No active certificate covers this domain
                  </SelectItem>
                ) : (
                  matchingCertificates.map((certificate) => (
                    <SelectItem key={certificate.id} value={certificate.id}>
                      {certificate.name} · {certificate.domainNames.join(", ")}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </SettingsControlRow>
        </>
      )}
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Repository-scoped pull/push tokens remain authoritative for external access.
        </span>
      </div>
    </PanelShell>
  );
}
