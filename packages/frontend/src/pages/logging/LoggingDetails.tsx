import { EllipsisVertical, KeyRound, Plus, Save, ScrollText, Settings, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { CommandPalettePageActions } from "@/components/common/CommandPalettePageActions";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { loggingEnvironmentRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import type { LoggingEnvironment, LoggingSchema, LoggingSchemaMode } from "@/types";
import { LoggingExplorer } from "./LoggingExplorer";
import { LoggingSchemaEditor } from "./LoggingSchemaEditor";
import { LoggingTokenPanel } from "./LoggingTokenPanel";
import { isLoggingEnvironmentSettingsDirty, isLoggingSchemaDirty } from "./logging-state";

export type LoggingEnvironmentTab = "logs" | "tokens" | "settings";

export function LoggingSchemaDetail({
  schema,
  loading,
  canEdit,
  canDelete,
  onSave,
  onDelete,
}: {
  schema: LoggingSchema | null;
  loading: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSave: (patch: Partial<LoggingSchema>) => Promise<void>;
  onDelete: (schema: LoggingSchema) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Partial<LoggingSchema>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!schema) return;
    setDraft({
      name: schema.name,
      description: schema.description,
      schemaMode: schema.schemaMode,
      fieldSchema: schema.fieldSchema,
    });
  }, [schema]);

  if (loading) return <DetailPageSkeleton label="Loading logging schema" tabs={3} />;
  if (!schema) {
    return (
      <PageTransition>
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Logging schema not found.
        </div>
      </PageTransition>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };
  const dirty = isLoggingSchemaDirty(schema, draft);

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <CommandPalettePageActions
          actions={[
            ...(canEdit
              ? [
                  {
                    id: "logging-schema:save",
                    label: saving ? "Saving schema" : "Save schema changes",
                    icon: <Save className="h-4 w-4" />,
                    disabled: saving || !dirty,
                    action: () => void save(),
                  },
                ]
              : []),
            ...(canDelete
              ? [
                  {
                    id: "logging-schema:delete",
                    label: "Delete logging schema",
                    icon: <Trash2 className="h-4 w-4" />,
                    action: () => void onDelete(schema),
                  },
                ]
              : []),
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <PageBackButton onClick={() => navigate("/logging/schemas")} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{schema.name}</h1>
                <Badge variant="secondary" size="inline" className="uppercase">
                  {draft.schemaMode ?? schema.schemaMode}
                </Badge>
                <Badge variant="outline" size="inline">
                  {(draft.fieldSchema ?? schema.fieldSchema).length} fields
                </Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {schema.slug} · Updated {new Date(schema.updatedAt).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {canEdit && (
              <Button disabled={saving || !dirty} onClick={() => void save()}>
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save Changes"}
              </Button>
            )}
            {canDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => void onDelete(schema)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SettingsPanel title="Metadata" description="Reusable schema identity">
            <SettingsTextRow
              label="Name"
              description="Display name used in schema lists"
              value={draft.name ?? ""}
              disabled={!canEdit}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <SettingsTextRow
              label="Description"
              description="Optional operator-facing note"
              value={draft.description ?? ""}
              disabled={!canEdit}
              onChange={(description) => setDraft({ ...draft, description })}
            />
          </SettingsPanel>

          <SettingsPanel title="Behavior" description="Validation mode for attached environments">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">Mode</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Unknown labels and fields are handled during ingest
                </p>
              </div>
              <Select
                disabled={!canEdit}
                value={draft.schemaMode ?? schema.schemaMode}
                onValueChange={(schemaMode) =>
                  setDraft({ ...draft, schemaMode: schemaMode as LoggingSchemaMode })
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reject">Reject</SelectItem>
                  <SelectItem value="strip">Strip</SelectItem>
                  <SelectItem value="loose">Loose</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingsPanel>
        </div>

        <LoggingSchemaEditor
          schema={{
            schemaMode: draft.schemaMode ?? schema.schemaMode,
            fieldSchema: draft.fieldSchema ?? schema.fieldSchema,
          }}
          canEdit={canEdit}
          onSave={async (patch) => setDraft((current) => ({ ...current, ...patch }))}
        />
      </div>
    </PageTransition>
  );
}

export function LoggingEnvironmentDetail({
  environment,
  schemas,
  loggingEnabled,
  loading,
  activeTab,
  canEdit,
  canDelete,
  canCreateToken,
  canDeleteToken,
  onUpdate,
  onDelete,
}: {
  environment: LoggingEnvironment | null;
  schemas: LoggingSchema[];
  loggingEnabled: boolean;
  loading: boolean;
  activeTab: LoggingEnvironmentTab;
  canEdit: boolean;
  canDelete: boolean;
  canCreateToken: boolean;
  canDeleteToken: boolean;
  onUpdate: (environmentId: string, patch: Partial<LoggingEnvironment>) => Promise<void>;
  onDelete: (environment: LoggingEnvironment) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [settingsDraft, setSettingsDraft] = useState<Partial<LoggingEnvironment>>({});
  const [logsRefreshKey, setLogsRefreshKey] = useState(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);

  useEffect(() => {
    if (!environment) return;
    setSettingsDraft(environment);
  }, [environment]);

  if (loading) return <DetailPageSkeleton label="Loading logging environment" tabs={3} />;
  if (!environment) {
    return (
      <PageTransition>
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          Logging environment not found.
        </div>
      </PageTransition>
    );
  }

  const isFullHeightTab = activeTab === "logs";
  const settingsDirty = isLoggingEnvironmentSettingsDirty(environment, settingsDraft);
  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      await onUpdate(environment.id, settingsDraft);
      toast.success("Environment settings saved");
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <PageTransition>
      <div
        className={
          isFullHeightTab
            ? "h-full flex flex-col overflow-hidden gap-4 p-6"
            : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        <CommandPalettePageActions
          actions={[
            ...(activeTab === "logs"
              ? [
                  {
                    id: "logging-environment:refresh",
                    label: "Refresh logs",
                    icon: <ScrollText className="h-4 w-4" />,
                    disabled: !loggingEnabled,
                    action: () => setLogsRefreshKey((current) => current + 1),
                  },
                ]
              : []),
            ...(activeTab === "tokens" && canCreateToken
              ? [
                  {
                    id: "logging-environment:new-token",
                    label: "Create ingest token",
                    icon: <Plus className="h-4 w-4" />,
                    action: () => setTokenDialogOpen(true),
                  },
                ]
              : []),
            ...(activeTab === "settings" && canEdit
              ? [
                  {
                    id: "logging-environment:save",
                    label: settingsSaving ? "Saving environment" : "Save environment settings",
                    icon: <Save className="h-4 w-4" />,
                    disabled: !settingsDirty || settingsSaving,
                    action: () => void saveSettings(),
                  },
                ]
              : []),
            ...(activeTab === "settings" && canDelete
              ? [
                  {
                    id: "logging-environment:delete",
                    label: "Delete logging environment",
                    icon: <Trash2 className="h-4 w-4" />,
                    action: () => void onDelete(environment),
                  },
                ]
              : []),
          ]}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <PageBackButton onClick={() => navigate("/logging/environments")} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate text-2xl font-bold">{environment.name}</h1>
                <Badge variant={environment.enabled ? "success" : "secondary"} size="inline">
                  {environment.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Badge variant="secondary" size="inline">
                  {environment.schemaMode}
                </Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {environment.slug} · {environment.schemaName ?? "No schema attached"} ·{" "}
                {environment.retentionDays}d retention
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {activeTab === "logs" && (
              <RefreshButton
                onClick={() => setLogsRefreshKey((current) => current + 1)}
                disabled={!loggingEnabled}
                minDurationMs={1000}
              />
            )}
            {activeTab === "tokens" && canCreateToken && (
              <Button onClick={() => setTokenDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                New Token
              </Button>
            )}
            {activeTab === "settings" && canEdit && (
              <Button
                disabled={!settingsDirty || settingsSaving}
                onClick={() => void saveSettings()}
              >
                <Save className="h-4 w-4" />
                {settingsSaving ? "Saving..." : "Save Changes"}
              </Button>
            )}
            {activeTab === "settings" && canDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => void onDelete(environment)}
                    className="text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={(value) => navigate(loggingEnvironmentRoute(environment.slug, value))}
          className={cn("flex flex-col", isFullHeightTab && "flex-1 min-h-0")}
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="logs" className="gap-1.5">
              <ScrollText className="h-3.5 w-3.5" />
              Logs
            </TabsTrigger>
            <TabsTrigger value="tokens" className="gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              Tokens
            </TabsTrigger>
            <TabsTrigger value="settings" className="gap-1.5">
              <Settings className="h-3.5 w-3.5" />
              Settings
            </TabsTrigger>
          </TabsList>
          <TabsContent value="logs" className="flex flex-col flex-1 min-h-0">
            <LoggingExplorer
              environment={environment}
              storageAvailable={loggingEnabled}
              refreshKey={logsRefreshKey}
            />
          </TabsContent>
          <TabsContent value="tokens">
            <LoggingTokenPanel
              environment={environment}
              canDelete={canDeleteToken}
              createDialogOpen={tokenDialogOpen}
              onCreateDialogOpenChange={setTokenDialogOpen}
            />
          </TabsContent>
          <TabsContent value="settings">
            <LoggingEnvironmentSettings
              environment={environment}
              schemas={schemas}
              canEdit={canEdit}
              draft={settingsDraft}
              onDraftChange={setSettingsDraft}
            />
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}

function LoggingEnvironmentSettings({
  environment,
  schemas,
  canEdit,
  draft,
  onDraftChange,
}: {
  environment: LoggingEnvironment;
  schemas: LoggingSchema[];
  canEdit: boolean;
  draft: Partial<LoggingEnvironment>;
  onDraftChange: (draft: Partial<LoggingEnvironment>) => void;
}) {
  const selectedSchemaId = draft.schemaId === undefined ? environment.schemaId : draft.schemaId;
  const selectedSchema = schemas.find((schema) => schema.id === selectedSchemaId) ?? null;
  const effectiveSchemaMode = selectedSchema?.schemaMode ?? "loose";

  return (
    <div className="space-y-6 pb-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsPanel
          title="Schema"
          description="Reusable validation attached to this environment"
        >
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Attached schema</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Reusable labels, fields, and schema mode
              </p>
            </div>
            <Select
              disabled={!canEdit}
              value={draft.schemaId ?? "none"}
              onValueChange={(schemaId) =>
                onDraftChange({ ...draft, schemaId: schemaId === "none" ? null : schemaId })
              }
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No schema</SelectItem>
                {schemas.map((schema) => (
                  <SelectItem key={schema.id} value={schema.id}>
                    {schema.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Mode</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Effective unknown-field behavior for this environment
              </p>
            </div>
            <Badge variant="secondary" className="uppercase">
              {effectiveSchemaMode}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Enabled</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Disabled environments reject ingest tokens and hide new writes
              </p>
            </div>
            <Switch
              disabled={!canEdit}
              checked={draft.enabled ?? environment.enabled}
              onChange={(enabled: boolean) => onDraftChange({ ...draft, enabled })}
            />
          </div>
        </SettingsPanel>

        <SettingsPanel title="Ingest" description="Environment-specific retention and throttles">
          <SettingsNumberRow
            label="Retention days"
            description="Stored per event and enforced by ClickHouse TTL"
            value={draft.retentionDays ?? environment.retentionDays}
            min={1}
            max={365}
            disabled={!canEdit}
            onChange={(retentionDays) =>
              onDraftChange({
                ...draft,
                retentionDays: retentionDays ?? environment.retentionDays,
              })
            }
          />
          <SettingsNumberRow
            label="Request limit"
            description="Per-window request limit for this environment"
            value={draft.rateLimitRequestsPerWindow ?? ""}
            min={1}
            disabled={!canEdit}
            onChange={(rateLimitRequestsPerWindow) =>
              onDraftChange({ ...draft, rateLimitRequestsPerWindow })
            }
          />
          <SettingsNumberRow
            label="Event limit"
            description="Per-window event limit for this environment"
            value={draft.rateLimitEventsPerWindow ?? ""}
            min={1}
            disabled={!canEdit}
            onChange={(rateLimitEventsPerWindow) =>
              onDraftChange({ ...draft, rateLimitEventsPerWindow })
            }
          />
        </SettingsPanel>
      </div>
    </div>
  );
}

function SettingsPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <PanelShell
      title={title}
      description={description}
      bodyClassName="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border"
    >
      {children}
    </PanelShell>
  );
}

function SettingsTextRow({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Input
        className="w-[260px]"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function SettingsNumberRow({
  label,
  description,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: number | "";
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Input
        className="w-[180px]"
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      />
    </div>
  );
}

function SettingsValueRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="text-right text-sm text-muted-foreground">{value}</div>
    </div>
  );
}

export function LoggingGlobalSettings({
  loggingEnabled,
  environmentCount,
  schemaCount,
}: {
  loggingEnabled: boolean;
  environmentCount: number;
  schemaCount: number;
}) {
  return (
    <div className="space-y-6 pb-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SettingsPanel title="Storage" description="External structured log storage">
          <SettingsValueRow
            label="Status"
            description="External structured log storage"
            value={
              <Badge variant={loggingEnabled ? "success" : "secondary"}>
                {loggingEnabled ? "Enabled" : "Disabled"}
              </Badge>
            }
          />
        </SettingsPanel>

        <SettingsPanel title="Inventory" description="Configured logging metadata">
          <SettingsValueRow
            label="Environments"
            description="Configured ingest boundaries"
            value={<Badge variant="outline">{environmentCount}</Badge>}
          />
          <SettingsValueRow
            label="Schemas"
            description="Reusable validation schemas"
            value={<Badge variant="outline">{schemaCount}</Badge>}
          />
        </SettingsPanel>
      </div>
    </div>
  );
}
