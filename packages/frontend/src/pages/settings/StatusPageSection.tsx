import { Save } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelShell } from "@/components/common/PanelShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { handleLicenseApiError, requireLicenseFeature } from "@/stores/license-paywall";
import type {
  DatabaseConnection,
  DockerContainer,
  Node,
  ProxyHost,
  SSLCertificate,
  StatusPageConfig,
  StatusPageIncident,
  StatusPageIncidentSeverity,
  StatusPageProxyTemplateOption,
  StatusPageServiceItem,
  StatusPageSourceType,
} from "@/types";

interface StatusPageSectionProps {
  nodesList: Node[];
}

type ServiceSourceType = StatusPageSourceType | "docker";

const DEFAULT_CONFIG: StatusPageConfig = {
  enabled: false,
  title: "System Status",
  description: "",
  domain: "",
  nodeId: null,
  sslCertificateId: null,
  proxyTemplateId: null,
  upstreamUrl: null,
  proxyHostId: null,
  publicIncidentLimit: 25,
  recentIncidentDays: 14,
  autoDegradedEnabled: true,
  autoOutageEnabled: true,
  autoDegradedSeverity: "warning",
  autoOutageSeverity: "critical",
  autoCreateThresholdSeconds: 600,
  autoResolveThresholdSeconds: 60,
};

export function statusBadge(status: string) {
  if (status === "operational" || status === "online") return "success";
  if (status === "info") return "info";
  if (status === "degraded" || status === "maintenance" || status === "warning") return "warning";
  if (status === "outage" || status === "offline" || status === "critical") return "destructive";
  return "secondary";
}

export function getStatusPreviewUrl() {
  if (!import.meta.env.DEV) return "/_status-preview/";
  const url = new URL(window.location.href);
  url.port = "5174";
  url.pathname = "/_status-preview/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function StatusPageSection({ nodesList }: StatusPageSectionProps) {
  const { hasScope } = useAuthStore();
  const canManage = hasScope("status-page:manage");
  const [config, setConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("settings:status-page-config") ?? DEFAULT_CONFIG
  );
  const [savedConfig, setSavedConfig] = useState<StatusPageConfig>(
    () => api.getCached<StatusPageConfig>("settings:status-page-config") ?? DEFAULT_CONFIG
  );
  const [sslCerts, setSslCerts] = useState<SSLCertificate[]>(
    () => api.getCached<SSLCertificate[]>("settings:status-page-ssl-certs") ?? []
  );
  const [proxyTemplates, setProxyTemplates] = useState<StatusPageProxyTemplateOption[]>(
    () =>
      api.getCached<StatusPageProxyTemplateOption[]>("settings:status-page-proxy-templates") ?? []
  );
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    () =>
      api.getCached<StatusPageConfig>("settings:status-page-config") !== undefined &&
      api.getCached<SSLCertificate[]>("settings:status-page-ssl-certs") !== undefined &&
      api.getCached<StatusPageProxyTemplateOption[]>("settings:status-page-proxy-templates") !==
        undefined
  );
  const [savingSettings, setSavingSettings] = useState(false);

  const onlineNginxNodes = useMemo(
    () => nodesList.filter((node) => node.type === "nginx" && node.status === "online"),
    [nodesList]
  );

  const loadStatusPage = useCallback(async () => {
    try {
      const settings = await api.getStatusPageSettings();
      api.setCache("settings:status-page-config", settings);
      setConfig(settings);
      setSavedConfig(settings);
    } catch {
      /* optional feature; ignore until user opens it */
    }
  }, []);

  const loadProxyTemplates = useCallback(async () => {
    try {
      const templates = await api.listStatusPageProxyTemplates();
      api.setCache("settings:status-page-proxy-templates", templates);
      setProxyTemplates(templates);
    } catch {
      setProxyTemplates([]);
    }
  }, []);

  useEffect(() => {
    void Promise.allSettled([
      loadStatusPage(),
      loadProxyTemplates(),
      api.listSSLCertificates({ limit: 100 }).then((res) => {
        api.setCache("settings:status-page-ssl-certs", res.data ?? []);
        setSslCerts(res.data ?? []);
      }),
    ]).finally(() => setInitialLoadComplete(true));
  }, [loadProxyTemplates, loadStatusPage]);

  useRealtime("status-page.changed", () => {
    loadStatusPage();
  });
  useRealtime("nginx.template.changed", () => {
    loadProxyTemplates();
  });

  const statusPageSettingsPayload = useMemo(
    () => ({
      enabled: config.enabled,
      domain: config.domain,
      upstreamUrl: config.upstreamUrl?.trim() ? config.upstreamUrl.trim() : null,
      nodeId: config.nodeId || null,
      sslCertificateId: config.sslCertificateId,
      proxyTemplateId: config.proxyTemplateId,
    }),
    [
      config.domain,
      config.enabled,
      config.nodeId,
      config.proxyTemplateId,
      config.sslCertificateId,
      config.upstreamUrl,
    ]
  );

  const savedStatusPageSettingsPayload = useMemo(
    () => ({
      enabled: savedConfig.enabled,
      domain: savedConfig.domain,
      upstreamUrl: savedConfig.upstreamUrl?.trim() ? savedConfig.upstreamUrl.trim() : null,
      nodeId: savedConfig.nodeId || null,
      sslCertificateId: savedConfig.sslCertificateId,
      proxyTemplateId: savedConfig.proxyTemplateId,
    }),
    [
      savedConfig.domain,
      savedConfig.enabled,
      savedConfig.nodeId,
      savedConfig.proxyTemplateId,
      savedConfig.sslCertificateId,
      savedConfig.upstreamUrl,
    ]
  );

  const hasSettingsChanges =
    JSON.stringify(statusPageSettingsPayload) !== JSON.stringify(savedStatusPageSettingsPayload);

  const saveConfig = async () => {
    if (!canManage) return;
    setSavingSettings(true);
    try {
      const updated = await api.updateStatusPageSettings(statusPageSettingsPayload);
      api.setCache("settings:status-page-config", updated);
      setConfig(updated);
      setSavedConfig(updated);
      toast.success("Status page settings updated");
    } catch (err) {
      if (!handleLicenseApiError(err, "Status Page")) {
        toast.error(err instanceof Error ? err.message : "Failed to update status page");
      }
      loadStatusPage();
    } finally {
      setSavingSettings(false);
    }
  };

  if (!initialLoadComplete) return <Skeleton />;

  return (
    <PanelShell
      title="Status Page"
      description="Enable the public status page and configure its custom domain"
      actions={
        <Button onClick={saveConfig} disabled={!canManage || savingSettings || !hasSettingsChanges}>
          <Save className="h-4 w-4" />
          Save
        </Button>
      }
      dirty={hasSettingsChanges}
    >
      <div className="divide-y divide-border">
        <SettingsRow
          label="Enabled"
          description="Expose the public status page through the configured domain"
          controlClassName="w-auto"
          preserveRow
        >
          <Switch
            checked={config.enabled}
            disabled={!canManage || savingSettings}
            onChange={(enabled) => {
              if (enabled && !requireLicenseFeature("status-pages", "Status Page")) return;
              setConfig((prev) => ({ ...prev, enabled }));
            }}
          />
        </SettingsRow>
        <SettingsRow label="Domain" description="Public hostname for the status page">
          <Input
            value={config.domain}
            disabled={!canManage || savingSettings}
            placeholder="status.example.com"
            onChange={(event) => setConfig((prev) => ({ ...prev, domain: event.target.value }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Gateway upstream URL"
          description="Internal Gateway URL used by the generated proxy host"
        >
          <Input
            value={config.upstreamUrl ?? ""}
            disabled={!canManage || savingSettings}
            placeholder="http://172.16.20.60:3000"
            onChange={(event) =>
              setConfig((prev) => ({ ...prev, upstreamUrl: event.target.value }))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Ingress node"
          description="Online Ingress node that serves the public status page"
        >
          <Select
            value={config.nodeId ?? ""}
            disabled={!canManage || config.enabled || savingSettings}
            onValueChange={(nodeId) => setConfig((prev) => ({ ...prev, nodeId }))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select an online Ingress node" />
            </SelectTrigger>
            <SelectContent>
              {onlineNginxNodes.map((node) => (
                <SelectItem key={node.id} value={node.id} disabled={node.serviceCreationLocked}>
                  {node.displayName || node.hostname}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="SSL certificate"
          description="Certificate presented by the public status page endpoint"
        >
          <Select
            value={config.sslCertificateId ?? "__none__"}
            disabled={!canManage || savingSettings}
            onValueChange={(sslCertificateId) =>
              setConfig((prev) => ({
                ...prev,
                sslCertificateId: sslCertificateId === "__none__" ? null : sslCertificateId,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No certificate</SelectItem>
              {sslCerts
                .filter((cert) => cert.status === "active")
                .map((cert) => (
                  <SelectItem key={cert.id} value={cert.id}>
                    {cert.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Proxy template"
          description="Optional nginx template override for the generated proxy host"
        >
          <Select
            value={config.proxyTemplateId ?? "__default__"}
            disabled={!canManage || savingSettings}
            onValueChange={(proxyTemplateId) =>
              setConfig((prev) => ({
                ...prev,
                proxyTemplateId: proxyTemplateId === "__default__" ? null : proxyTemplateId,
              }))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">Default template</SelectItem>
              {proxyTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </div>
    </PanelShell>
  );
}

function SettingsRow({
  label,
  description,
  children,
  controlClassName = "w-full md:w-[28rem]",
  preserveRow = false,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
  controlClassName?: string;
  /** Keep compact controls, such as a switch, aligned with their description at every width. */
  preserveRow?: boolean;
}) {
  return (
    <label
      className={
        preserveRow
          ? "flex flex-row items-center justify-between gap-4 px-4 py-3"
          : "flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-4"
      }
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <span className={`min-w-0 shrink-0 ${controlClassName}`}>{children}</span>
    </label>
  );
}

export function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ServiceDialog({
  open,
  onOpenChange,
  service,
  services,
  nodes,
  proxies,
  databases,
  dockerTargets = [],
  sourceOptionsLoading = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: StatusPageServiceItem | null;
  services: StatusPageServiceItem[];
  nodes: Node[];
  proxies: ProxyHost[];
  databases: DatabaseConnection[];
  dockerTargets?: DockerContainer[];
  sourceOptionsLoading?: boolean;
  onSaved: () => void;
}) {
  const [sourceType, setSourceType] = useState<ServiceSourceType>("proxy_host");
  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState("");
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSourceType(
      service?.sourceType?.startsWith("docker_") ? "docker" : (service?.sourceType ?? "proxy_host")
    );
    setSourceId(service?.sourceId ?? "");
    setName(service?.publicName ?? "");
    setDescription(service?.publicDescription ?? "");
    setGroup(service?.publicGroup ?? "");
    setEnabled(service?.enabled ?? true);
  }, [open, service]);

  const sourceOptions = useMemo(() => {
    const exposed = new Set(
      services.filter((item) => item.id !== service?.id).map((item) => item.sourceId)
    );
    if (sourceType === "node") {
      return nodes.map((node) => ({ id: node.id, label: node.displayName || node.hostname }));
    }
    if (sourceType === "database") {
      return databases.map((database) => ({ id: database.id, label: database.name }));
    }
    if (sourceType === "docker") {
      return dockerTargets.flatMap((item) => {
        if (item.kind === "deployment") {
          if (!item.deploymentId || !item.healthCheckEnabled || exposed.has(item.deploymentId)) {
            return [];
          }
          return [
            { id: `docker_deployment:${item.deploymentId}`, label: `Deployment: ${item.name}` },
          ];
        }
        if (!item.healthCheckId || !item.healthCheckEnabled || exposed.has(item.healthCheckId)) {
          return [];
        }
        return [{ id: `docker_container:${item.healthCheckId}`, label: `Container: ${item.name}` }];
      });
    }
    return proxies
      .filter((proxy) => proxy.healthCheckEnabled && !proxy.isSystem && !exposed.has(proxy.id))
      .map((proxy) => ({ id: proxy.id, label: proxy.domainNames[0] || proxy.id }));
  }, [databases, dockerTargets, nodes, proxies, service?.id, services, sourceType]);

  const save = async () => {
    try {
      const payload = {
        publicName: name.trim(),
        publicDescription: description.trim() || null,
        publicGroup: group.trim() || null,
        enabled,
      };
      if (service) {
        await api.updateStatusPageService(service.id, payload);
        toast.success("Exposed service updated");
      } else {
        const [resolvedSourceType, ...resolvedSourceIdParts] =
          sourceType === "docker" ? sourceId.split(":") : [sourceType, sourceId];
        await api.createStatusPageService({
          ...payload,
          sourceType: resolvedSourceType as StatusPageSourceType,
          sourceId: resolvedSourceIdParts.join(":"),
        });
        toast.success("Service exposed");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save service");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{service ? "Edit Exposed Service" : "Expose Service"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!service && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Source type">
                <Select
                  value={sourceType}
                  onValueChange={(value) => {
                    setSourceType(value as ServiceSourceType);
                    setSourceId("");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="node">Node</SelectItem>
                    <SelectItem value="proxy_host">Proxy Host</SelectItem>
                    <SelectItem value="database">Database</SelectItem>
                    <SelectItem value="docker">Docker</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Source">
                <Select
                  value={sourceId}
                  onValueChange={setSourceId}
                  disabled={sourceOptionsLoading}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={sourceOptionsLoading ? "Loading sources..." : "Select source"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Public name">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Public description">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field label="Group">
            <Input value={group} onChange={(event) => setGroup(event.target.value)} />
          </Field>
          <div className="flex items-center justify-between border border-border p-3">
            <span className="text-sm font-medium">Visible on public page</span>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim() || (!service && !sourceId)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function IncidentDialog({
  open,
  onOpenChange,
  incident,
  services,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incident: StatusPageIncident | null;
  services: StatusPageServiceItem[];
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [severity, setSeverity] = useState<StatusPageIncidentSeverity>("warning");
  const [affectedServiceIds, setAffectedServiceIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(incident?.title ?? "");
    setMessage(incident?.message ?? "");
    setSeverity(incident?.severity ?? "warning");
    setAffectedServiceIds(incident?.affectedServiceIds ?? []);
  }, [incident, open]);

  const save = async () => {
    try {
      const payload = {
        title: title.trim(),
        message: message.trim(),
        severity,
        affectedServiceIds,
      };
      if (incident) {
        await api.updateStatusPageIncident(incident.id, payload);
        toast.success("Incident updated");
      } else {
        await api.createStatusPageIncident(payload);
        toast.success("Incident created");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save incident");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{incident ? "Edit Incident Details" : "Create Incident"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              className="min-h-28"
            />
          </Field>
          <Field label="Severity">
            <Select value={severity} onValueChange={(value) => setSeverity(value as never)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="space-y-2 border border-border p-3">
            {services.map((service) => (
              <label key={service.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={affectedServiceIds.includes(service.id)}
                  onChange={(event) =>
                    setAffectedServiceIds((prev) =>
                      event.target.checked
                        ? [...prev, service.id]
                        : prev.filter((id) => id !== service.id)
                    )
                  }
                />
                {service.publicName}
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!title.trim() || !message.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
