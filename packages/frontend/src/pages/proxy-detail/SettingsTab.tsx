import { Loader2, Minus, Plus, RefreshCw, Save } from "lucide-react";
import { Combobox } from "@/components/common/Combobox";
import { PanelShell } from "@/components/common/PanelShell";
import { SettingsControlRow, SettingsInlineControl } from "@/components/common/SettingsControlRow";
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
  NginxTemplate,
  ProxyHost,
  RewriteRule,
  SSLCertificate,
} from "@/types";
import { AdditionalRoutesPanel } from "./AdditionalRoutes";
import { AdditionalSecureLinkBindings } from "./AdditionalSecureLinkBindings";

const tableInputClass =
  "h-9 border-0 rounded-none shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

export interface SettingsTabProps {
  host: ProxyHost;
  onHostUpdated: (host: ProxyHost) => void;
  onToggle: (field: string, value: boolean) => void;
  customHeaders: CustomHeader[];
  setCustomHeaders: (v: CustomHeader[]) => void;
  customRewrites: RewriteRule[];
  setCustomRewrites: (v: RewriteRule[]) => void;
  onSaveHeaders: () => void;
  onSaveRewrites: () => void;
  isSavingCustom: boolean;
  accessListId: string;
  accessLists: AccessList[];
  onAccessListChange: (v: string) => void;
  sslCerts: SSLCertificate[];
  sslEnabled: boolean;
  setSslEnabled: (v: boolean) => void;
  sslForced: boolean;
  setSslForced: (v: boolean) => void;
  http2Support: boolean;
  setHttp2Support: (v: boolean) => void;
  sslCertificateId: string;
  setSslCertificateId: (v: string) => void;
  onSaveSsl: () => void;
  isSavingSsl: boolean;
  hasSslSettingsChanged: boolean;
  nginxTemplates: NginxTemplate[];
  nginxTemplateId: string;
  onNginxTemplateChange: (v: string) => void;
  selectedTemplate: NginxTemplate | null;
  templateVariables: Record<string, string | number | boolean>;
  onTemplateVariableChange: (name: string, value: string | number | boolean) => void;
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
  healthCheckEnabled: boolean;
  setHealthCheckEnabled: (v: boolean) => void;
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
  onSaveHealthCheck: () => void;
  isSavingHealthCheck: boolean;
  hasHealthCheckSettingsChanged: boolean;
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
  customRewrites,
  setCustomRewrites,
  onSaveHeaders,
  onSaveRewrites,
  isSavingCustom,
  accessListId,
  accessLists,
  onAccessListChange,
  sslCerts,
  sslEnabled,
  setSslEnabled,
  sslForced,
  setSslForced,
  http2Support,
  setHttp2Support,
  sslCertificateId,
  setSslCertificateId,
  onSaveSsl,
  isSavingSsl,
  hasSslSettingsChanged,
  nginxTemplates,
  nginxTemplateId,
  onNginxTemplateChange,
  selectedTemplate,
  templateVariables,
  onTemplateVariableChange,
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
  healthCheckEnabled,
  setHealthCheckEnabled,
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
  onSaveHealthCheck,
  isSavingHealthCheck,
  hasHealthCheckSettingsChanged,
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
          { name: "redirectUrl", description: "Redirect target URL", type: "string" as const },
          {
            name: "redirectStatusCode",
            description: "Redirect status code",
            type: "number" as const,
          },
        ]
      : [];
  const templateVariableDefinitions = selectedTemplate?.variables ?? [];
  const cacheEnabled = templateVariables.cacheEnabled === true;
  const rateLimitMode =
    templateVariables.rateLimitMode === "custom" || templateVariables.rateLimitMode === "disabled"
      ? templateVariables.rateLimitMode
      : "inherit";
  const showCustomHeaders = canManage || customHeaders.length > 0;
  const showCustomRewrites = canManage || customRewrites.length > 0;
  const tlsDistributionProblem =
    host.sslEnabled &&
    host.tlsDistribution &&
    (host.tlsDistribution.status !== "ready" ||
      host.tlsDistribution.readyReplicaCount < host.tlsDistribution.replicaCount ||
      Boolean(host.tlsDistribution.error))
      ? host.tlsDistribution
      : null;

  const renderBuiltinValue = (variable: (typeof editableBuiltinVariables)[number]) => {
    if (variable.name === "redirectUrl") {
      return (
        <Input
          value={templateRedirectUrl}
          onChange={(event) => setTemplateRedirectUrl(event.target.value)}
          className={tableInputClass}
          disabled={!canManage}
        />
      );
    }
    return (
      <NumericInput
        value={templateRedirectStatusCode}
        onChange={setTemplateRedirectStatusCode}
        min={300}
        max={399}
        className={tableInputClass}
        disabled={!canManage}
      />
    );
  };

  const renderTemplateValue = (variable: NonNullable<NginxTemplate["variables"]>[number]) => {
    const disabledByDependency =
      (variable.name === "cacheMaxAge" && !cacheEnabled) ||
      (["rateLimitRPS", "rateLimitBurst", "connectionsPerIp"].includes(variable.name) &&
        rateLimitMode !== "custom");

    if (variable.name === "rateLimitMode") {
      return (
        <Select
          value={rateLimitMode}
          onValueChange={(value) => onTemplateVariableChange(variable.name, value)}
          disabled={!canManage}
        >
          <SelectTrigger className={cn(tableInputClass, "font-sans")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="font-sans">
            <SelectItem value="inherit">Gateway default (1000 / 3000 / 1000)</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (variable.name === "cacheEnabled") {
      return (
        <Select
          value={templateVariables[variable.name] === true ? "enabled" : "disabled"}
          onValueChange={(value) => onTemplateVariableChange(variable.name, value === "enabled")}
          disabled={!canManage}
        >
          <SelectTrigger className={cn(tableInputClass, "font-sans")} aria-label="Cache enabled">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="font-sans">
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (variable.type === "boolean") {
      return (
        <div className="flex h-9 items-center justify-end px-3">
          <Switch
            checked={templateVariables[variable.name] === true}
            onChange={(value) => onTemplateVariableChange(variable.name, value)}
            disabled={!canManage}
          />
        </div>
      );
    }
    if (variable.type === "number") {
      return (
        <NumericInput
          value={Number(templateVariables[variable.name] ?? variable.default ?? 0)}
          onChange={(value) => onTemplateVariableChange(variable.name, value)}
          min={1}
          className={tableInputClass}
          disabled={!canManage || disabledByDependency}
        />
      );
    }
    return (
      <Input
        value={String(templateVariables[variable.name] ?? variable.default ?? "")}
        onChange={(event) => onTemplateVariableChange(variable.name, event.target.value)}
        placeholder={variable.default === undefined ? "" : String(variable.default)}
        className={tableInputClass}
        disabled={!canManage || disabledByDependency}
      />
    );
  };

  return (
    <div className="space-y-4">
      {tlsDistributionProblem && (
        <PanelShell
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span>TLS distribution</span>
              <Badge
                size="inline"
                variant={
                  tlsDistributionProblem.status === "ready"
                    ? "success"
                    : tlsDistributionProblem.status === "failed"
                      ? "destructive"
                      : "warning"
                }
              >
                {tlsDistributionProblem.status.replaceAll("_", " ")}
              </Badge>
            </div>
          }
          description={
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span>
                {tlsDistributionProblem.readyReplicaCount}/{tlsDistributionProblem.replicaCount}{" "}
                replicas ready
              </span>
              {tlsDistributionProblem.lastVerifiedAt && (
                <span>Last verified {formatDateTime(tlsDistributionProblem.lastVerifiedAt)}</span>
              )}
              {tlsDistributionProblem.error && (
                <span className="break-words">{tlsDistributionProblem.error}</span>
              )}
            </span>
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

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 32rem), 1fr))" }}
      >
        {host.type === "proxy" && (
          <PanelShell title="WebSocket Support" description="Enable WebSocket proxying">
            <SettingsControlRow title="Enabled" description="Allow WebSocket protocol upgrades">
              <Switch
                checked={host.websocketSupport}
                onChange={(value) => onToggle("websocketSupport", value)}
                disabled={!canManage}
              />
            </SettingsControlRow>
          </PanelShell>
        )}
        <PanelShell
          title="Access List"
          description="Restrict access via IP rules or basic authentication"
          className="overflow-visible"
        >
          <SettingsControlRow title="Policy" description="Access policy applied to this proxy host">
            <Combobox
              value={accessListId}
              options={accessListOptions}
              onValueChange={onAccessListChange}
              placeholder="None"
              searchPlaceholder="Search access lists..."
              emptyMessage="No access lists found."
              disabled={!canManage}
              ariaLabel="Access List policy"
              className="w-full"
            />
          </SettingsControlRow>
        </PanelShell>
      </div>

      {host.type === "proxy" && (
        <ProxyUpstreamPanel host={host} canManage={canManage} onUpdated={onHostUpdated} />
      )}

      {host.type === "proxy" && (
        <AdditionalRoutesPanel
          host={host}
          canManage={canManage}
          selectedTemplate={selectedTemplate}
        />
      )}

      {host.type === "proxy" && !host.rawConfigEnabled ? (
        <AdditionalSecureLinkBindings hostId={host.id} canManage={canManage} />
      ) : null}

      <PanelShell
        title="Config Template"
        description="Select a template and configure its variables"
        actions={
          canManage ? (
            <Button
              onClick={onSaveTemplateSettings}
              disabled={!hasTemplateSettingsChanged || isSavingTemplate}
            >
              {isSavingTemplate ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {isSavingTemplate ? "Saving..." : "Save"}
            </Button>
          ) : null
        }
        wrapHeader
      >
        <SettingsControlRow title="Template" description="Nginx configuration used for this host">
          <Select
            value={nginxTemplateId || "__none__"}
            onValueChange={(value) => onNginxTemplateChange(value === "__none__" ? "" : value)}
            disabled={!canManage}
          >
            <SelectTrigger className="w-full font-sans sm:w-72">
              <SelectValue placeholder="Default template" />
            </SelectTrigger>
            <SelectContent className="font-sans">
              <SelectItem value="__none__">Default template</SelectItem>
              {nginxTemplates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsControlRow>

        {editableBuiltinVariables.length > 0 || templateVariableDefinitions.length > 0 ? (
          <div className="overflow-x-auto">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <div className="px-3 py-2">Variable</div>
                <div className="border-l border-border px-3 py-2">Description</div>
                <div className="border-l border-border px-3 py-2">Value</div>
              </div>
              {[...editableBuiltinVariables, ...templateVariableDefinitions].map((variable) => (
                <div
                  key={variable.name}
                  className="grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] border-b border-border last:border-b-0"
                >
                  <div className="flex min-w-0 items-center px-3 py-2">
                    <p className="truncate text-sm font-medium">{variable.name}</p>
                  </div>
                  <div className="flex min-w-0 items-center border-l border-border px-3 py-2">
                    <p className="text-xs text-muted-foreground">
                      {variable.description || "No description"}
                    </p>
                  </div>
                  <div className="border-l border-border">
                    {editableBuiltinVariables.includes(variable as never)
                      ? renderBuiltinValue(variable as (typeof editableBuiltinVariables)[number])
                      : renderTemplateValue(
                          variable as NonNullable<NginxTemplate["variables"]>[number]
                        )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </PanelShell>

      <PanelShell
        title="SSL"
        description="HTTPS termination and transport settings"
        actions={
          canManage ? (
            <Button onClick={onSaveSsl} disabled={!hasSslSettingsChanged || isSavingSsl}>
              {isSavingSsl ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {isSavingSsl ? "Saving..." : "Save"}
            </Button>
          ) : null
        }
        wrapHeader
      >
        <SettingsControlRow title="Enabled" description="Serve this host over HTTPS">
          <Switch checked={sslEnabled} onChange={setSslEnabled} disabled={!canManage} />
        </SettingsControlRow>
        <SettingsControlRow title="Force HTTPS" description="Redirect HTTP requests to HTTPS">
          <Switch
            checked={sslForced}
            onChange={setSslForced}
            disabled={!canManage || !sslEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow title="HTTP/2" description="Enable HTTP/2 protocol support">
          <Switch
            checked={http2Support}
            onChange={setHttp2Support}
            disabled={!canManage || !sslEnabled}
          />
        </SettingsControlRow>
        <SettingsControlRow title="SSL Certificate" description="Certificate used for HTTPS">
          <Select
            value={sslCertificateId || "__none__"}
            onValueChange={(value) => setSslCertificateId(value === "__none__" ? "" : value)}
            disabled={!canManage}
          >
            <SelectTrigger className="w-full font-sans sm:w-72" aria-label="SSL Certificate">
              <SelectValue placeholder="Select certificate..." />
            </SelectTrigger>
            <SelectContent className="font-sans">
              <SelectItem value="__none__">None</SelectItem>
              {sslCerts.map((certificate) => (
                <SelectItem key={certificate.id} value={certificate.id}>
                  {certificate.name} ({certificate.type})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsControlRow>
      </PanelShell>

      {host.type !== "404" && (
        <PanelShell
          title="Health Check"
          description="Periodic upstream availability monitoring"
          actions={
            canManage ? (
              <Button
                onClick={onSaveHealthCheck}
                disabled={!hasHealthCheckSettingsChanged || isSavingHealthCheck}
              >
                {isSavingHealthCheck ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {isSavingHealthCheck ? "Saving..." : "Save"}
              </Button>
            ) : null
          }
          wrapHeader
        >
          <SettingsControlRow title="Enabled" description="Run periodic health probes">
            <Switch
              checked={healthCheckEnabled}
              onChange={setHealthCheckEnabled}
              disabled={!canManage}
            />
          </SettingsControlRow>
          <SettingsControlRow title="URL Path" description="Path requested from the upstream">
            <Input
              value={healthCheckUrl}
              onChange={(event) => setHealthCheckUrl(event.target.value)}
              placeholder="/"
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Expected Status"
            description="Leave empty to accept any successful 2xx response"
          >
            <Input
              type="number"
              value={healthCheckExpectedStatus ?? ""}
              onChange={(event) =>
                setHealthCheckExpectedStatus(event.target.value ? Number(event.target.value) : null)
              }
              placeholder="Any 2xx"
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Slow Threshold"
            description="Mark degraded above this multiple of the 3-hour average; 0 disables it"
          >
            <NumericInput
              value={healthCheckSlowThreshold}
              onChange={setHealthCheckSlowThreshold}
              min={0}
              max={100}
              className="w-full sm:w-72"
              disabled={!canManage || !healthCheckEnabled}
            />
          </SettingsControlRow>
          <SettingsControlRow
            title="Expected Body"
            description="Optional response body assertion"
            controlsClassName="sm:min-w-[24rem] sm:max-w-[32rem]"
          >
            <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <SettingsInlineControl label="Match">
                <Select
                  value={healthCheckBodyMatchMode}
                  onValueChange={(value) =>
                    setHealthCheckBodyMatchMode(
                      value as "includes" | "exact" | "starts_with" | "ends_with"
                    )
                  }
                  disabled={!canManage || !healthCheckEnabled}
                >
                  <SelectTrigger className="font-sans">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="font-sans">
                    <SelectItem value="includes">Includes</SelectItem>
                    <SelectItem value="exact">Exact Match</SelectItem>
                    <SelectItem value="starts_with">Starts With</SelectItem>
                    <SelectItem value="ends_with">Ends With</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsInlineControl>
              <SettingsInlineControl label="Value">
                <Input
                  value={healthCheckExpectedBody}
                  onChange={(event) => setHealthCheckExpectedBody(event.target.value)}
                  placeholder="Optional"
                  disabled={!canManage || !healthCheckEnabled}
                />
              </SettingsInlineControl>
            </div>
          </SettingsControlRow>
        </PanelShell>
      )}

      {showCustomHeaders && (
        <PanelShell
          title="Custom Headers"
          description="Headers added to proxied requests"
          actions={
            canManage ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Add custom header"
                  title="Add custom header"
                  onClick={() => setCustomHeaders([...customHeaders, { name: "", value: "" }])}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
                <Button onClick={onSaveHeaders} disabled={!hasHeadersChanged || isSavingCustom}>
                  {isSavingCustom ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {isSavingCustom ? "Saving..." : "Save"}
                </Button>
              </div>
            ) : null
          }
          wrapHeader
        >
          {customHeaders.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[560px]">
                <div className="grid grid-cols-[1fr_1fr_2.25rem] border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <div className="px-3 py-2">Header</div>
                  <div className="border-l border-border px-3 py-2">Value</div>
                  <div className="border-l border-border" />
                </div>
                {customHeaders.map((header, index) => (
                  <div
                    key={`header-${index}`}
                    className="grid grid-cols-[1fr_1fr_2.25rem] border-b border-border last:border-b-0"
                  >
                    <Input
                      placeholder="Header name"
                      value={header.name}
                      disabled={!canManage}
                      className={tableInputClass}
                      onChange={(event) => {
                        const next = [...customHeaders];
                        next[index] = { ...next[index], name: event.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    <Input
                      placeholder="Value"
                      value={header.value}
                      disabled={!canManage}
                      className={cn(tableInputClass, "border-l border-border")}
                      onChange={(event) => {
                        const next = [...customHeaders];
                        next[index] = { ...next[index], value: event.target.value };
                        setCustomHeaders(next);
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-none border-l border-border"
                      aria-label={`Remove custom header ${index + 1}`}
                      onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== index))}
                      disabled={!canManage}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              No custom headers
            </div>
          )}
        </PanelShell>
      )}

      {showCustomRewrites && (
        <PanelShell
          title="URL Rewrites"
          description="Rewrite request paths before proxying"
          actions={
            canManage ? (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
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
                <Button onClick={onSaveRewrites} disabled={!hasRewritesChanged || isSavingCustom}>
                  {isSavingCustom ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {isSavingCustom ? "Saving..." : "Save"}
                </Button>
              </div>
            ) : null
          }
          wrapHeader
        >
          {customRewrites.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid grid-cols-[1fr_1fr_11rem_2.25rem] border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <div className="px-3 py-2">Source</div>
                  <div className="border-l border-border px-3 py-2">Destination</div>
                  <div className="border-l border-border px-3 py-2">Type</div>
                  <div className="border-l border-border" />
                </div>
                {customRewrites.map((rule, index) => (
                  <div
                    key={`rewrite-${index}`}
                    className="grid grid-cols-[1fr_1fr_11rem_2.25rem] border-b border-border last:border-b-0"
                  >
                    <Input
                      placeholder="Source path"
                      value={rule.source}
                      disabled={!canManage}
                      className={tableInputClass}
                      onChange={(event) => {
                        const next = [...customRewrites];
                        next[index] = { ...next[index], source: event.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Input
                      placeholder="Destination"
                      value={rule.destination}
                      disabled={!canManage}
                      className={cn(tableInputClass, "border-l border-border")}
                      onChange={(event) => {
                        const next = [...customRewrites];
                        next[index] = { ...next[index], destination: event.target.value };
                        setCustomRewrites(next);
                      }}
                    />
                    <Select
                      value={rule.type}
                      onValueChange={(value) => {
                        const next = [...customRewrites];
                        next[index] = {
                          ...next[index],
                          type: value as "permanent" | "temporary",
                        };
                        setCustomRewrites(next);
                      }}
                      disabled={!canManage}
                    >
                      <SelectTrigger
                        className={cn(
                          tableInputClass,
                          "border-l border-border font-sans focus:ring-1 focus:ring-inset focus:ring-ring"
                        )}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="font-sans">
                        <SelectItem value="permanent">Permanent</SelectItem>
                        <SelectItem value="temporary">Temporary</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 rounded-none border-l border-border"
                      aria-label={`Remove URL rewrite ${index + 1}`}
                      onClick={() =>
                        setCustomRewrites(customRewrites.filter((_, i) => i !== index))
                      }
                      disabled={!canManage}
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              No URL rewrites
            </div>
          )}
        </PanelShell>
      )}
    </div>
  );
}
