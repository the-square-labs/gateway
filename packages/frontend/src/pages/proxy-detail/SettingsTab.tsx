import { AnimatePresence, motion } from "framer-motion";
import { Minus, Plus, RefreshCw, Save } from "lucide-react";
import type { ReactNode } from "react";
import { Combobox } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { ProxyUpstreamPanel } from "@/components/proxy/ProxyUpstreamEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumericInput } from "@/components/ui/numeric-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn, formatDateTime } from "@/lib/utils";
import type {
  AccessList,
  CustomHeader,
  ForwardScheme,
  NginxTemplate,
  ProxyHost,
  RewriteRule,
  SSLCertificate,
} from "@/types";
import { ToggleRow } from "./helpers";

function TogglePanelShell({
  title,
  description,
  checked,
  onChange,
  disabled,
  className,
  children,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <PanelShell
      title={title}
      description={description}
      className={className}
      actions={<Switch checked={checked} onChange={onChange} disabled={disabled} />}
      wrapHeader
    >
      {children}
    </PanelShell>
  );
}

export interface SettingsTabProps {
  host: ProxyHost;
  onHostUpdated: (host: ProxyHost) => void;
  onToggle: (field: string, value: boolean) => void;
  customHeaders: CustomHeader[];
  setCustomHeaders: (v: CustomHeader[]) => void;
  cacheEnabled: boolean;
  setCacheEnabled: (v: boolean) => void;
  cacheMaxAge: number;
  setCacheMaxAge: (v: number) => void;
  rateLimitEnabled: boolean;
  setRateLimitEnabled: (v: boolean) => void;
  rateLimitRPS: number;
  setRateLimitRPS: (v: number) => void;
  rateLimitBurst: number;
  setRateLimitBurst: (v: number) => void;
  customRewrites: RewriteRule[];
  setCustomRewrites: (v: RewriteRule[]) => void;
  onSaveCustom: () => void;
  isSavingCustom: boolean;
  accessListId: string;
  accessLists: AccessList[];
  onAccessListChange: (v: string) => void;
  sslCerts: SSLCertificate[];
  onSslCertificateChange: (v: string) => void;
  nginxTemplates: NginxTemplate[];
  nginxTemplateId: string;
  onNginxTemplateChange: (v: string) => void;
  selectedTemplate: NginxTemplate | null;
  templateVariables: Record<string, string | number | boolean>;
  onTemplateVariableChange: (name: string, value: string | number | boolean) => void;
  templateForwardScheme: ForwardScheme;
  setTemplateForwardScheme: (value: ForwardScheme) => void;
  templateForwardHost: string;
  setTemplateForwardHost: (value: string) => void;
  templateForwardPort: number;
  setTemplateForwardPort: (value: number) => void;
  templateRedirectUrl: string;
  setTemplateRedirectUrl: (value: string) => void;
  templateRedirectStatusCode: number;
  setTemplateRedirectStatusCode: (value: number) => void;
  onSaveTemplateSettings: () => void;
  isSavingTemplate: boolean;
  hasTemplateSettingsChanged: boolean;
  canManage: boolean;
  hasHeadersChanged: boolean;
  hasRewritesChanged: boolean;
  healthCheckUrl: string;
  setHealthCheckUrl: (v: string) => void;
  healthCheckExpectedStatus: number | null;
  setHealthCheckExpectedStatus: (v: number | null) => void;
  healthCheckExpectedBody: string;
  setHealthCheckExpectedBody: (v: string) => void;
  healthCheckBodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  setHealthCheckBodyMatchMode: (v: "includes" | "exact" | "starts_with" | "ends_with") => void;
  healthCheckSlowThreshold: number;
  setHealthCheckSlowThreshold: (v: number) => void;
  canResyncTls: boolean;
  isTlsResyncing: boolean;
  onTlsResync: () => void;
}

export function SettingsTab({
  host,
  onHostUpdated,
  onToggle,
  customHeaders,
  setCustomHeaders,
  cacheEnabled,
  setCacheEnabled,
  cacheMaxAge,
  setCacheMaxAge,
  rateLimitEnabled,
  setRateLimitEnabled,
  rateLimitRPS,
  setRateLimitRPS,
  rateLimitBurst,
  setRateLimitBurst,
  customRewrites,
  setCustomRewrites,
  onSaveCustom,
  isSavingCustom,
  accessListId,
  accessLists,
  onAccessListChange,
  sslCerts,
  onSslCertificateChange,
  nginxTemplates,
  nginxTemplateId,
  onNginxTemplateChange,
  selectedTemplate,
  templateVariables,
  onTemplateVariableChange,
  templateForwardScheme,
  setTemplateForwardScheme,
  templateForwardHost,
  setTemplateForwardHost,
  templateForwardPort,
  setTemplateForwardPort,
  templateRedirectUrl,
  setTemplateRedirectUrl,
  templateRedirectStatusCode,
  setTemplateRedirectStatusCode,
  onSaveTemplateSettings,
  isSavingTemplate,
  hasTemplateSettingsChanged,
  canManage,
  hasHeadersChanged,
  hasRewritesChanged,
  healthCheckUrl,
  setHealthCheckUrl,
  healthCheckExpectedStatus,
  setHealthCheckExpectedStatus,
  healthCheckExpectedBody,
  setHealthCheckExpectedBody,
  healthCheckBodyMatchMode,
  setHealthCheckBodyMatchMode,
  healthCheckSlowThreshold,
  setHealthCheckSlowThreshold,
  canResyncTls,
  isTlsResyncing,
  onTlsResync,
}: SettingsTabProps) {
  const accessListOptions = [
    { value: "", label: "None" },
    ...accessLists.map((accessList) => ({ value: accessList.id, label: accessList.name })),
  ];
  const editableBuiltinVariables =
    host.type === "redirect"
      ? [
          {
            name: "redirectUrl",
            description: "Redirect target URL",
            type: "string" as const,
          },
          {
            name: "redirectStatusCode",
            description: "Redirect status code",
            type: "number" as const,
          },
        ]
      : [];

  const showCustomHeaders = canManage || customHeaders.length > 0;
  const showCustomRewrites = canManage || customRewrites.length > 0;

  return (
    <div className="space-y-4">
      {host.sslEnabled && host.tlsDistribution && (
        <PanelShell
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span>TLS distribution</span>
              <Badge
                size="inline"
                variant={
                  host.tlsDistribution.status === "ready"
                    ? "success"
                    : host.tlsDistribution.status === "failed"
                      ? "destructive"
                      : "warning"
                }
              >
                {host.tlsDistribution.status.replaceAll("_", " ")}
              </Badge>
            </div>
          }
          description={
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <span>
                {host.tlsDistribution.readyReplicaCount}/{host.tlsDistribution.replicaCount}{" "}
                replicas ready
              </span>
              {host.tlsDistribution.lastVerifiedAt && (
                <span>Last verified {formatDateTime(host.tlsDistribution.lastVerifiedAt)}</span>
              )}
              {host.tlsDistribution.error && (
                <span className="break-words">{host.tlsDistribution.error}</span>
              )}
            </div>
          }
          actions={
            canResyncTls ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onTlsResync}
                disabled={isTlsResyncing}
                aria-label={`Retry TLS sync for ${host.domainNames[0] || "proxy host"}`}
              >
                <RefreshCw className={cn("h-4 w-4", isTlsResyncing && "animate-spin")} />
                Retry TLS Sync
              </Button>
            ) : null
          }
          wrapHeader
        />
      )}

      {/* WebSocket + Access List -- side by side */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 32rem), 1fr))" }}
      >
        {host.type === "proxy" && (
          <TogglePanelShell
            title="WebSocket Support"
            description="Enable WebSocket proxying"
            checked={host.websocketSupport}
            onChange={(v) => onToggle("websocketSupport", v)}
            disabled={!canManage}
          />
        )}
        <PanelShell
          title="Access List"
          description="Restrict access via IP rules or basic authentication"
          className="overflow-visible"
          actions={
            <Combobox
              value={accessListId}
              options={accessListOptions}
              onValueChange={onAccessListChange}
              placeholder="None"
              searchPlaceholder="Search access lists..."
              emptyMessage="No access lists found."
              disabled={!canManage}
              className="w-full shrink-0 sm:w-56"
            />
          }
          headerBorder={false}
          wrapHeader
        />
      </div>

      {host.type === "proxy" && (
        <ProxyUpstreamPanel host={host} canManage={canManage} onUpdated={onHostUpdated} />
      )}

      <PanelShell
        title="Config Template"
        description="Select a proxy template and configure its variables"
        actions={
          canManage ? (
            <Button
              className="w-fit"
              onClick={onSaveTemplateSettings}
              disabled={!hasTemplateSettingsChanged || isSavingTemplate}
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </Button>
          ) : null
        }
        bodyClassName="p-4 space-y-4"
        wrapHeader
      >
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Template</label>
          <Select
            value={nginxTemplateId || "__none__"}
            onValueChange={(v) => onNginxTemplateChange(v === "__none__" ? "" : v)}
            disabled={!canManage}
          >
            <SelectTrigger>
              <SelectValue placeholder="Default template" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Default template</SelectItem>
              {nginxTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {editableBuiltinVariables.length > 0 || selectedTemplate?.variables?.length ? (
          <div className="overflow-x-auto border border-border">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,12rem)] border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <div className="px-3 py-2">Variable</div>
                <div className="px-3 py-2 border-l border-border">Description</div>
                <div className="px-3 py-2 border-l border-border">Value</div>
              </div>
              <div>
                {editableBuiltinVariables.map((variable) => (
                  <div
                    key={variable.name}
                    className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,12rem)] border-b border-border last:border-b-0"
                  >
                    <div className="px-3 py-2 min-w-0 flex items-center">
                      <p className="text-sm font-medium truncate">{variable.name}</p>
                    </div>
                    <div className="border-l border-border">
                      <div className="flex h-9 items-center px-3 min-w-0">
                        <p className="text-sm font-medium truncate">{variable.description}</p>
                      </div>
                    </div>
                    <div className="border-l border-border">
                      {variable.name === "forwardScheme" ? (
                        <Select
                          value={templateForwardScheme}
                          onValueChange={(value) =>
                            setTemplateForwardScheme(value as ForwardScheme)
                          }
                          disabled={!canManage}
                        >
                          <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="http">http</SelectItem>
                            <SelectItem value="https">https</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : variable.name === "forwardHost" ? (
                        <Input
                          value={templateForwardHost}
                          onChange={(e) => setTemplateForwardHost(e.target.value)}
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      ) : variable.name === "forwardPort" ? (
                        <NumericInput
                          value={templateForwardPort}
                          onChange={(value) => setTemplateForwardPort(value)}
                          min={1}
                          max={65535}
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      ) : variable.name === "redirectUrl" ? (
                        <Input
                          value={templateRedirectUrl}
                          onChange={(e) => setTemplateRedirectUrl(e.target.value)}
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      ) : (
                        <NumericInput
                          value={templateRedirectStatusCode}
                          onChange={(value) => setTemplateRedirectStatusCode(value)}
                          min={300}
                          max={399}
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      )}
                    </div>
                  </div>
                ))}

                {selectedTemplate?.variables?.map((variable) => (
                  <div
                    key={variable.name}
                    className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,12rem)] border-b border-border last:border-b-0"
                  >
                    <div className="px-3 py-2 min-w-0 flex items-center">
                      <p className="text-sm font-medium truncate">{variable.name}</p>
                    </div>
                    <div className="border-l border-border">
                      <div className="flex h-9 items-center px-3 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {variable.description || "—"}
                        </p>
                      </div>
                    </div>
                    <div className="border-l border-border">
                      {variable.type === "boolean" ? (
                        <Select
                          value={
                            templateVariables[variable.name] === true ||
                            templateVariables[variable.name] === "true"
                              ? "true"
                              : "false"
                          }
                          onValueChange={(value) =>
                            onTemplateVariableChange(variable.name, value === "true")
                          }
                          disabled={!canManage}
                        >
                          <SelectTrigger className="h-9 border-0 rounded-none shadow-none focus:ring-1 focus:ring-inset focus:ring-ring">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">Enabled</SelectItem>
                            <SelectItem value="false">Disabled</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : variable.type === "number" ? (
                        <NumericInput
                          value={Number(templateVariables[variable.name] ?? variable.default ?? 0)}
                          onChange={(value) => onTemplateVariableChange(variable.name, value)}
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      ) : (
                        <Input
                          value={String(templateVariables[variable.name] ?? variable.default ?? "")}
                          onChange={(e) => onTemplateVariableChange(variable.name, e.target.value)}
                          placeholder={
                            variable.default !== undefined ? String(variable.default) : ""
                          }
                          className="h-9 text-xs border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          disabled={!canManage}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </PanelShell>

      {/* SSL */}
      <TogglePanelShell
        title="SSL Enabled"
        description="Serve this host over HTTPS"
        checked={host.sslEnabled}
        onChange={(v) => onToggle("sslEnabled", v)}
        disabled={!canManage}
      >
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_2fr] divide-y md:divide-y-0 md:divide-x divide-border">
          <ToggleRow
            label="Force HTTPS"
            description="Redirect HTTP to HTTPS"
            checked={host.sslForced}
            onChange={(v) => onToggle("sslForced", v)}
            disabled={!canManage || !host.sslEnabled}
          />
          <ToggleRow
            label="HTTP/2"
            description="Enable HTTP/2 protocol support"
            checked={host.http2Support}
            onChange={(v) => onToggle("http2Support", v)}
            disabled={!canManage || !host.sslEnabled}
          />
          <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="text-sm font-medium">SSL Certificate</span>
              <p className="text-xs text-muted-foreground">Select the certificate for HTTPS</p>
            </div>
            <div className="w-full shrink-0 sm:w-56">
              <Select
                value={host.sslCertificateId || "__none__"}
                onValueChange={(v) => onSslCertificateChange(v === "__none__" ? "" : v)}
                disabled={!canManage}
              >
                <SelectTrigger aria-label="SSL Certificate">
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
          </div>
        </div>
      </TogglePanelShell>

      {/* Cache & Rate Limit -- side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TogglePanelShell
          title="Cache"
          description="Enable response caching"
          checked={cacheEnabled}
          onChange={setCacheEnabled}
          disabled={!canManage}
        >
          <div className="space-y-1.5 px-4 py-3">
            <label className="text-xs text-muted-foreground">Max Age (seconds)</label>
            <NumericInput
              value={cacheMaxAge}
              onChange={(v) => setCacheMaxAge(v)}
              min={1}
              disabled={!canManage || !cacheEnabled}
            />
          </div>
        </TogglePanelShell>
        <TogglePanelShell
          title="Rate Limit"
          description="Enable request rate limiting"
          checked={rateLimitEnabled}
          onChange={setRateLimitEnabled}
          disabled={!canManage}
        >
          <div className="px-4 py-3 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Requests/sec</label>
              <NumericInput
                value={rateLimitRPS}
                onChange={setRateLimitRPS}
                min={1}
                disabled={!canManage || !rateLimitEnabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Burst</label>
              <NumericInput
                value={rateLimitBurst}
                onChange={setRateLimitBurst}
                min={1}
                disabled={!canManage || !rateLimitEnabled}
              />
            </div>
          </div>
        </TogglePanelShell>
      </div>

      {/* Health Check */}
      {host.type !== "404" && (
        <TogglePanelShell
          title="Health Check"
          description="Enable periodic health monitoring"
          checked={host.healthCheckEnabled}
          onChange={(v) => onToggle("healthCheckEnabled", v)}
          disabled={!canManage}
        >
          <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">URL Path</label>
              <Input
                value={healthCheckUrl}
                onChange={(e) => setHealthCheckUrl(e.target.value)}
                placeholder="/"
                disabled={!canManage || !host.healthCheckEnabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Expected Status</label>
              <Input
                type="number"
                value={healthCheckExpectedStatus ?? ""}
                onChange={(e) =>
                  setHealthCheckExpectedStatus(e.target.value ? Number(e.target.value) : null)
                }
                placeholder="Any 2xx"
                disabled={!canManage || !host.healthCheckEnabled}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Slow Threshold (Nx avg)</label>
              <Input
                type="number"
                min={0}
                value={healthCheckSlowThreshold}
                onChange={(e) => setHealthCheckSlowThreshold(Number(e.target.value) || 0)}
                placeholder="3"
                disabled={!canManage || !host.healthCheckEnabled}
              />
              <p className="text-[10px] text-muted-foreground">
                Mark degraded when response time exceeds Nx the 3-hour average. 0 to disable.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Expected Body</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                <Select
                  value={healthCheckBodyMatchMode}
                  onValueChange={(v) =>
                    setHealthCheckBodyMatchMode(
                      v as "includes" | "exact" | "starts_with" | "ends_with"
                    )
                  }
                  disabled={!canManage || !host.healthCheckEnabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="includes">Includes</SelectItem>
                    <SelectItem value="exact">Exact Match</SelectItem>
                    <SelectItem value="starts_with">Starts With</SelectItem>
                    <SelectItem value="ends_with">Ends With</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={healthCheckExpectedBody}
                  onChange={(e) => setHealthCheckExpectedBody(e.target.value)}
                  placeholder="Optional"
                  disabled={!canManage || !host.healthCheckEnabled}
                />
              </div>
            </div>
          </div>
        </TogglePanelShell>
      )}

      {/* Custom Headers */}
      {showCustomHeaders && (
        <PanelShell
          title="Custom Headers"
          description="Add custom HTTP headers to proxied requests"
          headerBorder={customHeaders.length > 0}
          actions={
            <div className="flex shrink-0 items-center gap-2">
              {canManage && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Add custom header"
                    title="Add custom header"
                    onClick={() => setCustomHeaders([...customHeaders, { name: "", value: "" }])}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button onClick={onSaveCustom} disabled={!hasHeadersChanged || isSavingCustom}>
                    <Save className="h-3.5 w-3.5" />
                    Save
                  </Button>
                </>
              )}
            </div>
          }
          wrapHeader
        >
          <motion.div
            animate={{ height: customHeaders.length > 0 ? "auto" : 0 }}
            initial={false}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="p-4 space-y-3">
              <AnimatePresence initial={false}>
                {customHeaders.map((header, i) => (
                  <motion.div
                    key={`header-${i}`}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                    className="flex flex-col gap-2 sm:flex-row"
                  >
                    <Input
                      placeholder="Header name"
                      value={header.name}
                      disabled={!canManage}
                      onChange={(e) => {
                        const next = [...customHeaders];
                        next[i] = { ...next[i], name: e.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    <Input
                      placeholder="Value"
                      value={header.value}
                      disabled={!canManage}
                      onChange={(e) => {
                        const next = [...customHeaders];
                        next[i] = { ...next[i], value: e.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCustomHeaders(customHeaders.filter((_, j) => j !== i))}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        </PanelShell>
      )}

      {/* URL Rewrites */}
      {showCustomRewrites && (
        <PanelShell
          title="URL Rewrites"
          description="Rewrite request paths before proxying"
          headerBorder={customRewrites.length > 0}
          actions={
            <div className="flex shrink-0 items-center gap-2">
              {canManage && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Add URL rewrite"
                    title="Add URL rewrite"
                    onClick={() =>
                      setCustomRewrites([
                        ...customRewrites,
                        { source: "", destination: "", type: "permanent" },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button onClick={onSaveCustom} disabled={!hasRewritesChanged || isSavingCustom}>
                    <Save className="h-3.5 w-3.5" />
                    Save
                  </Button>
                </>
              )}
            </div>
          }
          wrapHeader
        >
          <motion.div
            animate={{ height: customRewrites.length > 0 ? "auto" : 0 }}
            initial={false}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="overflow-hidden"
          >
            <div className="p-4 space-y-3">
              <AnimatePresence initial={false}>
                {customRewrites.map((rule, i) => (
                  <motion.div
                    key={`rewrite-${i}`}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                    className="flex flex-col gap-2 sm:flex-row"
                  >
                    <Input
                      placeholder="Source path"
                      value={rule.source}
                      disabled={!canManage}
                      onChange={(e) => {
                        const next = [...customRewrites];
                        next[i] = { ...next[i], source: e.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Input
                      placeholder="Destination"
                      value={rule.destination}
                      disabled={!canManage}
                      onChange={(e) => {
                        const next = [...customRewrites];
                        next[i] = { ...next[i], destination: e.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Select
                      value={rule.type}
                      onValueChange={(v) => {
                        const next = [...customRewrites];
                        next[i] = { ...next[i], type: v as "permanent" | "temporary" };
                        setCustomRewrites(next);
                      }}
                      disabled={!canManage}
                    >
                      <SelectTrigger className="w-full sm:w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="permanent">Permanent</SelectItem>
                        <SelectItem value="temporary">Temporary</SelectItem>
                      </SelectContent>
                    </Select>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setCustomRewrites(customRewrites.filter((_, j) => j !== i))}
                      >
                        <Minus className="h-4 w-4" />
                      </Button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        </PanelShell>
      )}
    </div>
  );
}
