import { Check, ChevronDown, KeyRound, Moon, SlidersHorizontal, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AI_APPROVAL_MODE_META,
  AI_APPROVAL_MODES,
  type AIApprovalMode,
} from "@/lib/ai-approval-mode";
import {
  confirmBypassEverythingMode,
  updateAIApprovalModeOptimistically,
} from "@/lib/ai-user-preferences";
import { deriveAllowedResourceIdsByScope, scopeMatches } from "@/lib/scope-utils";
import { getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { useUIStore } from "@/stores/ui";
import type { DatabaseConnection, LoggingSchema, Node, ProxyHost } from "@/types";
import { InferenceTokensSection } from "./inference/InferenceTokensSection";
import { InferenceUsage } from "./inference/InferenceUsagePanels";
import { ApiTokensSection } from "./settings/ApiTokensSection";
import { OAuthApplicationsSection } from "./settings/OAuthApplicationsSection";

const PROFILE_TABS = ["preferences", "authorizations"] as const;
type ProfileTab = (typeof PROFILE_TABS)[number];

function isProfileTab(value: string | null | undefined): value is ProfileTab {
  return PROFILE_TABS.includes(value as ProfileTab);
}

export function Profile() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { user, hasScope } = useAuthStore();
  const {
    theme,
    setTheme,
    showUpdateNotifications,
    setShowUpdateNotifications,
    showSystemCertificates,
    setShowSystemCertificates,
    showAILiteModeCTA,
    setShowAILiteModeCTA,
    aiApprovalMode,
  } = useUIStore();
  const [nodesList, setNodesList] = useState<Node[]>([]);
  const [proxyHostsList, setProxyHostsList] = useState<ProxyHost[]>([]);
  const [databasesList, setDatabasesList] = useState<DatabaseConnection[]>([]);
  const [loggingSchemasList, setLoggingSchemasList] = useState<LoggingSchema[]>([]);
  const activeTab: ProfileTab = isProfileTab(tabParam) ? tabParam : "preferences";
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const canUseAI = hasScope("feat:ai:use");
  const canUseInference = inferenceEnabled && hasScope("inference:use");
  const canViewInferenceUsage = hasScope("inference:usage:view:self");
  const canCreateInferenceTokens = hasScope("inference:tokens:create");
  const canRevokeInferenceTokens = hasScope("inference:tokens:revoke");
  const canViewSystemCertificates = hasScope("admin:details:certificates");
  const userScopes = user?.scopes;

  useEffect(() => {
    if (tabParam && !isProfileTab(tabParam)) {
      navigate("/profile", { replace: true });
    }
  }, [navigate, tabParam]);

  useEffect(() => {
    if (activeTab !== "authorizations") return;

    api
      .listNodes({ limit: 100 })
      .then((result) => setNodesList(result.data ?? []))
      .catch(() => {});
    api
      .listProxyHosts({ limit: 100 })
      .then((result) => setProxyHostsList(result.data ?? []))
      .catch(() => {});
    api
      .listDatabases({ limit: 200 })
      .then((result) => setDatabasesList(result.data ?? []))
      .catch(() => {});
    if (
      scopeMatches(userScopes ?? [], "logs:schemas:view") ||
      scopeMatches(userScopes ?? [], "logs:manage") ||
      (deriveAllowedResourceIdsByScope(userScopes ?? [])["logs:schemas:view"]?.length ?? 0) > 0
    ) {
      api
        .listLoggingSchemas()
        .then(setLoggingSchemasList)
        .catch(() => {});
    }
  }, [activeTab, userScopes]);

  const handleToggleSystemCertificates = (checked: boolean) => {
    setShowSystemCertificates(checked);
    api.invalidateCache("req:/api/cas");
    api.invalidateCache("req:/api/certificates");
    api.invalidateCache("req:/api/ssl-certificates");
    api.invalidateCache("req:/api/monitoring/dashboard");
    api.invalidateCache("cas:list:");
    api.invalidateCache("certificates:list:");
    api.invalidateCache("ssl:list:");
    api.invalidateCache("dashboard:stats:");
  };

  const handleAIApprovalModeChange = async (mode: AIApprovalMode) => {
    if (mode === aiApprovalMode) return;
    if (
      mode === "bypass-everything" &&
      aiApprovalMode !== "bypass-everything" &&
      !(await confirmBypassEverythingMode())
    ) {
      return;
    }

    try {
      await updateAIApprovalModeOptimistically(mode, aiApprovalMode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update AI mode");
    }
  };

  const handleTabChange = (value: string) => {
    navigate(value === "preferences" ? "/profile" : "/profile/authorizations");
  };

  return (
    <PageTransition>
      <div className="h-full space-y-4 overflow-y-auto p-6">
        <div className="flex items-center gap-3">
          <LiteModeBackButton />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">Profile</h1>
            <p className="text-sm text-muted-foreground">Personal settings and authorizations</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
          <TabsList className="shrink-0">
            <TabsTrigger value="preferences" className="gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Preferences
            </TabsTrigger>
            <TabsTrigger value="authorizations" className="gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              Authorizations
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preferences" className="pb-0">
            <div className="space-y-4">
              <PanelShell title="Profile">
                {user && (
                  <div className="flex items-center gap-4 p-4">
                    <Avatar className="h-10 w-10 shrink-0">
                      <AvatarImage src={user.avatarUrl ?? undefined} />
                      <AvatarFallback className="text-sm">
                        {getInitials(user.name || user.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{user.name || "Not set"}</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>
                    <Badge variant="secondary" size="inline">
                      {user.groupName}
                    </Badge>
                  </div>
                )}
              </PanelShell>

              <PanelShell title="Preferences">
                <div className="divide-y divide-border">
                  <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <div>
                      <p className="text-sm font-medium">Theme</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Choose how the interface looks
                      </p>
                    </div>
                    <div className="flex w-fit shrink-0 gap-0 border border-border">
                      {(["light", "dark", "system"] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTheme(value)}
                          className={`flex items-center gap-2 px-4 py-2 text-sm capitalize transition-colors ${
                            theme === value
                              ? "bg-primary text-primary-foreground"
                              : "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                        >
                          {value === "light" && <Sun className="h-3.5 w-3.5" />}
                          {value === "dark" && <Moon className="h-3.5 w-3.5" />}
                          {value}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">Update notifications</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Show update banners in sidebar and dashboard
                      </p>
                    </div>
                    <Switch
                      checked={showUpdateNotifications}
                      onChange={setShowUpdateNotifications}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">Lite mode shortcuts</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Show sidebar shortcuts for switching between Gateway and AI lite mode
                      </p>
                    </div>
                    <Switch checked={showAILiteModeCTA} onChange={setShowAILiteModeCTA} />
                  </div>
                  {canViewSystemCertificates && (
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">Show system certificates</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Include internal PKI and SSL certificates in lists and dashboard counts
                        </p>
                      </div>
                      <Switch
                        checked={showSystemCertificates}
                        onChange={handleToggleSystemCertificates}
                      />
                    </div>
                  )}
                  {canUseAI && (
                    <AIApprovalModeRow
                      value={aiApprovalMode}
                      onChange={handleAIApprovalModeChange}
                    />
                  )}
                </div>
              </PanelShell>

              {canUseInference && canViewInferenceUsage && <InferenceUsage />}
            </div>
          </TabsContent>

          <TabsContent value="authorizations" className="pb-0">
            <div className="space-y-4">
              <ApiTokensSection
                user={user}
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
              />
              <OAuthApplicationsSection
                nodesList={nodesList}
                proxyHostsList={proxyHostsList}
                databasesList={databasesList}
                loggingSchemasList={loggingSchemasList}
              />
              {canUseInference && (
                <InferenceTokensSection
                  canCreate={canCreateInferenceTokens}
                  canRevoke={canRevokeInferenceTokens}
                />
              )}
            </div>
          </TabsContent>
        </Tabs>

        <PoweredByFooter transitionKey={activeTab} />
      </div>
    </PageTransition>
  );
}

function AIApprovalModeRow({
  value,
  onChange,
}: {
  value: AIApprovalMode;
  onChange: (mode: AIApprovalMode) => void | Promise<void>;
}) {
  const current = AI_APPROVAL_MODE_META[value];
  const CurrentIcon = current.icon;

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">AI approval mode</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{current.description}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between sm:w-[250px]">
            <span className="flex min-w-0 items-center gap-2">
              <CurrentIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{current.menuLabel}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
          {AI_APPROVAL_MODES.map((mode) => {
            const item = AI_APPROVAL_MODE_META[mode];
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={mode}
                className="items-start gap-3"
                onSelect={() => void onChange(mode)}
              >
                <Icon className="mt-0.5 h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.menuLabel}</span>
                  <span className="block text-xs text-muted-foreground">{item.description}</span>
                </span>
                {value === mode && <Check className="mt-0.5 h-4 w-4" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
