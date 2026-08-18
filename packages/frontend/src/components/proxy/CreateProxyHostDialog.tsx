import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Loader2, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { DomainAutocompleteInput } from "@/components/domains/DomainAutocompleteInput";
import {
  DEFAULT_PROXY_UPSTREAM,
  isProxyUpstreamValid,
  ProxyUpstreamFields,
  type ProxyUpstreamSelection,
  proxyUpstreamFromHost,
  proxyUpstreamRequest,
} from "@/components/proxy/ProxyUpstreamEditor";
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
import { nodeTypeLabel } from "@/lib/node-appearance";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  CreateProxyHostRequest,
  DockerContainer,
  NginxTemplate,
  Node,
  ProxyHost,
  ProxyHostType,
  SSLCertificate,
} from "@/types";
import { isNodeIncompatible } from "@/types";

interface CreateProxyHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When editing, pre-fill with existing host data */
  existingHost?: ProxyHost | null;
  /** Optional entrypoint defaults when creating a route from a registered domain. */
  initialDomainName?: string;
  initialNodeId?: string;
  /** Called on successful create/update with the host ID and returned host payload when available. */
  onSuccess?: (hostId: string, host?: ProxyHost) => void;
}
interface NodeOption {
  id: string;
  hostname: string;
  status: string;
  type: string;
  serviceCreationLocked: boolean;
}

function mapNodeOptions(nodes: Node[]): NodeOption[] {
  return nodes
    .filter((node) => node.type === "nginx" && !isNodeIncompatible(node))
    .map((node) => ({
      id: node.id,
      hostname: node.displayName || node.hostname,
      status: node.status,
      type: node.type,
      serviceCreationLocked: node.serviceCreationLocked,
    }));
}

function getCachedNodeOptions(): NodeOption[] {
  const cached = api.getCached<{ data: Node[] }>("nodes:list:default");
  return mapNodeOptions(cached?.data ?? []);
}

const STEP_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

export function defaultProxyUpstreamForDockerTargets(
  targets: DockerContainer[]
): ProxyUpstreamSelection {
  const firstTarget = targets[0];
  if (!firstTarget) return DEFAULT_PROXY_UPSTREAM;
  return {
    ...DEFAULT_PROXY_UPSTREAM,
    kind: firstTarget.kind === "deployment" ? "docker_deployment" : "docker_container",
  };
}

export function CreateProxyHostDialog({
  open,
  onOpenChange,
  existingHost,
  initialDomainName,
  initialNodeId,
  onSuccess,
}: CreateProxyHostDialogProps) {
  const isEditing = !!existingHost;
  const hasScope = useAuthStore((state) => state.hasScope);
  const maintenanceLocked = !!existingHost?.maintenanceEnabled;

  // Step navigation
  const [step, setStep] = useState(1);

  // Step 1 — Basics
  const [type, setType] = useState<ProxyHostType>("proxy");
  const [nodeId, setNodeId] = useState<string>("");
  const [domainNames, setDomainNames] = useState<string[]>([""]);

  // Step 2 — Configuration: Proxy
  const [upstream, setUpstream] = useState<ProxyUpstreamSelection>(DEFAULT_PROXY_UPSTREAM);
  const upstreamTouchedRef = useRef(false);
  const [websocketSupport, setWebsocketSupport] = useState(false);

  // Step 2 — Configuration: Redirect
  const [redirectUrl, setRedirectUrl] = useState("");
  const [redirectStatusCode, setRedirectStatusCode] = useState(301);

  // Step 2 — SSL
  const [sslEnabled, setSslEnabled] = useState(false);
  const [sslForced, setSslForced] = useState(false);
  const [http2Support, setHttp2Support] = useState(false);
  const [sslCertificateId, setSslCertificateId] = useState("");
  const [internalCertificateId, setInternalCertificateId] = useState("");

  // Step 2 — Template
  const [nginxTemplateId, setNginxTemplateId] = useState("");
  const [templateVariables, setTemplateVariables] = useState<
    Record<string, string | number | boolean>
  >({});

  // Raw config mode (edit only)
  const [rawConfigEnabled, setRawConfigEnabled] = useState(false);

  // Saving state
  const [isSaving, setIsSaving] = useState(false);

  // Related data (fetched on open)
  const [nodes, setNodes] = useState<NodeOption[]>(getCachedNodeOptions);
  const [nodesLoading, setNodesLoading] = useState(nodes.length === 0);
  const [sslCerts, setSslCerts] = useState<SSLCertificate[]>([]);
  const [nginxTemplateList, setNginxTemplateList] = useState<NginxTemplate[]>([]);
  const [dockerContainers, setDockerContainers] = useState<DockerContainer[]>([]);

  // Reset entire form to defaults
  const resetForm = useCallback(() => {
    setStep(1);

    setType("proxy");
    setNodeId("");
    setDomainNames([""]);
    setUpstream(DEFAULT_PROXY_UPSTREAM);
    upstreamTouchedRef.current = false;
    setWebsocketSupport(false);
    setRedirectUrl("");
    setRedirectStatusCode(301);
    setSslEnabled(false);
    setSslForced(false);
    setHttp2Support(false);
    setSslCertificateId("");
    setInternalCertificateId("");
    setNginxTemplateId("");
    setTemplateVariables({});
    setRawConfigEnabled(false);
    setIsSaving(false);
    setDockerContainers([]);
  }, []);

  // Pre-fill from existingHost when it changes
  useEffect(() => {
    if (!existingHost) return;
    setType(existingHost.type);
    setNodeId((existingHost as any).nodeId || "");
    setDomainNames(existingHost.domainNames.length > 0 ? [...existingHost.domainNames] : [""]);
    setUpstream(proxyUpstreamFromHost(existingHost));
    upstreamTouchedRef.current = false;
    setWebsocketSupport(existingHost.websocketSupport);
    setRedirectUrl(existingHost.redirectUrl || "");
    setRedirectStatusCode(existingHost.redirectStatusCode || 301);
    setSslEnabled(existingHost.sslEnabled);
    setSslForced(existingHost.sslForced);
    setHttp2Support(existingHost.http2Support);
    setSslCertificateId(existingHost.sslCertificateId || "");
    setInternalCertificateId(existingHost.internalCertificateId || "");
    setNginxTemplateId(existingHost.nginxTemplateId || "");
    setTemplateVariables(existingHost.templateVariables || {});
    setRawConfigEnabled(existingHost.rawConfigEnabled ?? false);
    setStep(1);
  }, [existingHost]);

  useEffect(() => {
    if (!open || existingHost) return;
    setNodeId(initialNodeId ?? "");
    setDomainNames(initialDomainName ? [initialDomainName] : [""]);
  }, [existingHost, initialDomainName, initialNodeId, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const cachedNodes = getCachedNodeOptions();
    if (cachedNodes.length > 0) {
      setNodes(cachedNodes);
      setNodesLoading(false);
    } else if (nodes.length === 0) {
      setNodesLoading(true);
    }
  }, [nodes.length, open]);

  // Fetch related data when dialog opens
  useEffect(() => {
    if (!open) return;

    void api
      .listNodes({ type: "nginx" })
      .then((response) => setNodes(mapNodeOptions(response.data ?? [])))
      .catch(() => {})
      .finally(() => setNodesLoading(false));

    const loadSupportingData = async () => {
      try {
        const [sslRes, templateRes] = await Promise.all([
          api.listSSLCertificates({ limit: 100 }),
          api.listNginxTemplates(),
        ]);
        setSslCerts(sslRes.data || []);
        setNginxTemplateList(templateRes || []);
      } catch {
        // non-critical
      }
    };

    void loadSupportingData();
    void api
      .listDockerContainerSnapshots()
      .then(setDockerContainers)
      .catch(() => setDockerContainers([]));
  }, [open]);

  useEffect(() => {
    if (!open || isEditing || type !== "proxy" || upstreamTouchedRef.current) return;
    setUpstream(defaultProxyUpstreamForDockerTargets(dockerContainers));
  }, [dockerContainers, isEditing, open, type]);

  // Derived: user templates matching current type
  const userTemplates = useMemo(
    () => nginxTemplateList.filter((t) => !t.isBuiltin && t.type === type),
    [nginxTemplateList, type]
  );

  const visibleNodes = useMemo(
    () =>
      isEditing
        ? nodes
        : nodes.filter((node) => hasScope("proxy:create") || hasScope(`proxy:create:${node.id}`)),
    [hasScope, isEditing, nodes]
  );
  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.id === nodeId) ?? null,
    [nodeId, visibleNodes]
  );
  const selectedLockedForCreation =
    !!selectedNode?.serviceCreationLocked &&
    (!isEditing || selectedNode.id !== (existingHost as any)?.nodeId);

  // Validation
  const isStep1Valid =
    nodeId !== "" && !selectedLockedForCreation && domainNames.some((d) => d.trim() !== "");

  const isStep2Valid = (() => {
    if (type === "proxy" && !isProxyUpstreamValid(upstream)) return false;
    if (type === "redirect" && !redirectUrl.trim()) return false;
    if (sslEnabled && !sslCertificateId) return false;
    return true;
  })();

  // Navigation
  const goNext = () => setStep(2);
  const goBack = () => setStep(1);

  // Handle close
  const handleOpenChange = (value: boolean) => {
    onOpenChange(value);
  };

  // Build request payload
  const buildRequest = (): CreateProxyHostRequest => {
    const domains = domainNames.filter((d) => d.trim() !== "");
    const req: CreateProxyHostRequest = {
      type,
      nodeId,
      domainNames: domains,
      websocketSupport,
      sslEnabled,
      sslForced,
      http2Support,
      sslCertificateId: sslCertificateId || undefined,
      internalCertificateId: internalCertificateId || undefined,
      rawConfigEnabled: isEditing ? rawConfigEnabled : undefined,
      nginxTemplateId: nginxTemplateId || undefined,
      templateVariables: Object.keys(templateVariables).length > 0 ? templateVariables : undefined,
      healthCheckEnabled: isEditing ? undefined : false,
    };

    if (type === "proxy" && (!isEditing || existingHost?.type !== "proxy")) {
      Object.assign(req, proxyUpstreamRequest(upstream));
    }
    if (type === "redirect") {
      req.redirectUrl = redirectUrl;
      req.redirectStatusCode = redirectStatusCode;
    }

    return req;
  };

  // Save handler
  const handleSave = async () => {
    if (!isEditing && !isStep2Valid) return;

    setIsSaving(true);
    try {
      const data = buildRequest();

      // When enabling raw mode: seed rawConfig, set type to raw, disable healthcheck
      if (isEditing && existingHost && rawConfigEnabled && !existingHost.rawConfigEnabled) {
        try {
          const rendered = await api.getRenderedProxyConfig(existingHost.id);
          data.rawConfig = rendered.rendered;
        } catch {
          // If we can't fetch rendered config, proceed without seeding
        }
        data.type = "raw";
        data.healthCheckEnabled = false;
      }

      // When disabling raw mode: restore original type
      if (isEditing && existingHost && !rawConfigEnabled && existingHost.rawConfigEnabled) {
        // Type stays as whatever user had before (stored in the data from step 1)
        // but if it's still "raw", reset to proxy
        if (data.type === "raw") {
          data.type = "proxy";
          Object.assign(data, proxyUpstreamRequest(upstream));
        }
      }

      if (isEditing && existingHost) {
        const updated = await api.updateProxyHost(existingHost.id, data);
        toast.success("Route updated");
        onSuccess?.(existingHost.id, updated);
      } else {
        const created = await api.createProxyHost(data);
        toast.success("Route created");
        onSuccess?.(created.id, created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save route");
    } finally {
      setIsSaving(false);
    }
  };

  // Node status badge variant
  const nodeStatusVariant = (status: string) => {
    if (status === "online") return "success";
    if (status === "error") return "destructive";
    return "secondary";
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            resetForm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Route" : "Create Route"}</DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Configure the entrypoint for this route."
              : "Configure the target and TLS for this route."}
          </DialogDescription>
        </DialogHeader>

        <AnimatedHeight>
          <AnimatePresence initial={false} mode="popLayout">
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={STEP_ANIMATION.initial}
                animate={STEP_ANIMATION.animate}
                exit={STEP_ANIMATION.exit}
                transition={STEP_ANIMATION.transition}
                className="space-y-6"
              >
                {/* Type Selector */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Type</label>
                  <Select
                    value={rawConfigEnabled ? "raw" : type}
                    onValueChange={(v) => setType(v as ProxyHostType)}
                    disabled={rawConfigEnabled || maintenanceLocked}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rawConfigEnabled && <SelectItem value="raw">Raw</SelectItem>}
                      <SelectItem value="proxy">Proxy</SelectItem>
                      <SelectItem value="redirect">Redirect</SelectItem>
                      <SelectItem value="404">404</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Node Selector */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Ingress node</label>
                  <Select
                    value={nodeId || "__none__"}
                    onValueChange={(v) => setNodeId(v === "__none__" ? "" : v)}
                    disabled={nodesLoading}
                  >
                    <SelectTrigger aria-label="Ingress node" aria-busy={nodesLoading}>
                      {selectedNode ? (
                        <div className="flex min-w-0 items-center gap-3 pr-2">
                          <span className="min-w-0 flex-1 truncate">{selectedNode.hostname}</span>
                          <Badge variant="secondary" size="inline" className="shrink-0">
                            {nodeTypeLabel(selectedNode.type)}
                          </Badge>
                          <Badge
                            variant={nodeStatusVariant(selectedNode.status)}
                            size="inline"
                            className="shrink-0"
                          >
                            {selectedNode.status}
                          </Badge>
                        </div>
                      ) : (
                        <SelectValue
                          placeholder={nodesLoading ? "Loading nodes..." : "Select a node..."}
                        />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__" disabled>
                        {nodesLoading ? "Loading nodes..." : "Select a node..."}
                      </SelectItem>
                      {visibleNodes.map((node) => {
                        const lockedForCreation =
                          node.serviceCreationLocked &&
                          (!isEditing || node.id !== (existingHost as any)?.nodeId);
                        return (
                          <SelectItem key={node.id} value={node.id} disabled={lockedForCreation}>
                            <div className="flex items-center justify-between w-full gap-3">
                              <span className="min-w-0 truncate">{node.hostname}</span>
                              <Badge variant="secondary" size="inline">
                                {nodeTypeLabel(node.type)}
                              </Badge>
                              <Badge variant={nodeStatusVariant(node.status)} size="inline">
                                {node.status}
                              </Badge>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>

                {/* Domain Names */}
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Domain Names</label>
                  <div className="space-y-2">
                    <AnimatePresence initial={false}>
                      {domainNames.map((domain, i) => (
                        <motion.div
                          key={`domain-${i}`}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{
                            opacity: { duration: 0.12 },
                            y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                          }}
                          className="flex border border-input bg-background"
                        >
                          <DomainAutocompleteInput
                            value={domain}
                            nginxNodeId={nodeId || undefined}
                            onChange={(v) => {
                              const next = [...domainNames];
                              next[i] = v;
                              setDomainNames(next);
                            }}
                            onDomainSelect={(selectedDomain) => {
                              if (selectedDomain?.nginxNodeId) {
                                setNodeId(selectedDomain.nginxNodeId);
                              }
                            }}
                            placeholder="example.com"
                            inputClassName="border-0 shadow-none"
                          />
                          {domainNames.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              onClick={() => setDomainNames(domainNames.filter((_, j) => j !== i))}
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                          )}
                          {i === domainNames.length - 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              onClick={() => setDomainNames([...domainNames, ""])}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          )}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Raw mode toggle — only when editing */}
                {isEditing && (
                  <div className="border border-border bg-card">
                    <div className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Raw Config Mode</p>
                        <p className="text-xs text-muted-foreground">
                          Bypass template rendering and edit nginx config directly
                        </p>
                      </div>
                      <Switch
                        checked={rawConfigEnabled}
                        onChange={setRawConfigEnabled}
                        disabled={maintenanceLocked}
                      />
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {step === 2 && !isEditing && (
              <motion.div
                key="step-2"
                initial={STEP_ANIMATION.initial}
                animate={STEP_ANIMATION.animate}
                exit={STEP_ANIMATION.exit}
                transition={STEP_ANIMATION.transition}
                className="space-y-4"
              >
                {/* Forwarding / Redirect card */}
                {type === "proxy" && (
                  <PanelShell title="Forwarding">
                    <ProxyUpstreamFields
                      value={upstream}
                      onChange={(value) => {
                        upstreamTouchedRef.current = true;
                        setUpstream(value);
                      }}
                      containers={dockerContainers}
                    />
                  </PanelShell>
                )}

                {type === "redirect" && (
                  <div className="border border-border bg-card">
                    <div className="border-b border-border p-4">
                      <h2 className="font-semibold text-sm">Redirect</h2>
                    </div>
                    <div className="p-4">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">Redirect URL</label>
                          <Input
                            value={redirectUrl}
                            onChange={(e) => setRedirectUrl(e.target.value)}
                            placeholder="https://example.com"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">Status Code</label>
                          <Select
                            value={String(redirectStatusCode)}
                            onValueChange={(v) => setRedirectStatusCode(Number(v))}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="301">301 - Permanent</SelectItem>
                              <SelectItem value="302">302 - Temporary</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* SSL card — always visible, inner controls disabled when SSL off */}
                <div className="border border-border bg-card">
                  {type === "proxy" && (
                    <SettingsControlRow
                      title="WebSocket Support"
                      description="Enable WebSocket proxying"
                    >
                      <Switch checked={websocketSupport} onChange={setWebsocketSupport} />
                    </SettingsControlRow>
                  )}
                  {userTemplates.length > 0 && (
                    <SettingsControlRow
                      title="Config Template"
                      description="Nginx configuration template"
                    >
                      <Select
                        value={nginxTemplateId || "__none__"}
                        onValueChange={(v) => {
                          const newId = v === "__none__" ? "" : v;
                          setNginxTemplateId(newId);
                          if (newId) {
                            const tmpl = nginxTemplateList.find((t) => t.id === newId);
                            if (tmpl?.variables?.length) {
                              const defaults: Record<string, string | number | boolean> = {};
                              for (const vd of tmpl.variables) {
                                if (vd.default !== undefined) defaults[vd.name] = vd.default;
                              }
                              setTemplateVariables((prev) => ({ ...defaults, ...prev }));
                            }
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Default template" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Default template</SelectItem>
                          {userTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </SettingsControlRow>
                  )}
                  <SettingsControlRow title="SSL Enabled" description="Serve this host over HTTPS">
                    <Switch checked={sslEnabled} onChange={setSslEnabled} />
                  </SettingsControlRow>
                  <SettingsControlRow title="Force HTTPS" description="Redirect HTTP to HTTPS">
                    <div className={cn(!sslEnabled && "opacity-50")}>
                      <Switch checked={sslForced} onChange={setSslForced} disabled={!sslEnabled} />
                    </div>
                  </SettingsControlRow>
                  <SettingsControlRow title="HTTP/2" description="Enable HTTP/2 protocol support">
                    <div className={cn(!sslEnabled && "opacity-50")}>
                      <Switch
                        checked={http2Support}
                        onChange={setHttp2Support}
                        disabled={!sslEnabled}
                      />
                    </div>
                  </SettingsControlRow>
                  <SettingsControlRow title="SSL Certificate">
                    <div className={cn("w-full", !sslEnabled && "pointer-events-none opacity-50")}>
                      <Select
                        value={sslCertificateId || "__none__"}
                        onValueChange={(v) => setSslCertificateId(v === "__none__" ? "" : v)}
                        disabled={!sslEnabled}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select certificate..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {sslCerts.map((cert) => (
                            <SelectItem key={cert.id} value={cert.id}>
                              {cert.name} ({cert.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </SettingsControlRow>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </AnimatedHeight>

        <DialogFooter>
          {isEditing ? (
            <Button onClick={handleSave} disabled={!isStep1Valid || isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          ) : step === 1 ? (
            <Button onClick={goNext} disabled={!isStep1Valid}>
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <div className="flex w-full items-center justify-between">
              <Button variant="outline" onClick={goBack}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button onClick={handleSave} disabled={!isStep2Valid || isSaving}>
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                Create
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
