import { Bot, Network, Plug, ServerCog, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PoweredByFooter } from "@/components/common/PoweredByFooter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import type { Node } from "@/types";
import { AIConfigSection } from "./settings/AIConfigSection";
import { AuthProvisioningSection } from "./settings/AuthProvisioningSection";
import { DockerRegistriesSection } from "./settings/DockerRegistriesSection";
import { HousekeepingSection } from "./settings/HousekeepingSection";
import { InferenceSettingsSection } from "./settings/InferenceSettingsSection";
import { IntegrationsSection } from "./settings/IntegrationsSection";
import { LicenseSection } from "./settings/LicenseSection";
import { StatusPageSection } from "./settings/StatusPageSection";
import { UpdateSection } from "./settings/UpdateSection";

const SETTINGS_TABS = ["gateway", "features", "integrations", "inference", "ai"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return SETTINGS_TABS.includes(value as SettingsTab);
}

export function Settings() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const [nodesList, setNodesList] = useState<Node[]>([]);
  const activeTab = isSettingsTab(tabParam) ? tabParam : null;
  const inferenceEnabled = useSystemConfigStore((state) => state.config.features.inferenceEnabled);

  const canUpdate = hasScope("admin:update");
  const canViewGatewaySettings = hasScope("settings:gateway:view");
  const canEditGatewaySettings = hasScope("settings:gateway:edit");
  const canViewHousekeeping = hasScope("housekeeping:view");
  const canRunHousekeeping = hasScope("housekeeping:run");
  const canConfigureHousekeeping = hasScope("housekeeping:configure");
  const canConfigAI = hasScope("feat:ai:configure");
  const canConfigInference =
    inferenceEnabled &&
    (hasScope("inference:providers:view") ||
      hasScope("inference:models:manage") ||
      hasScope("inference:limits:manage") ||
      hasScope("inference:usage:view"));
  const canManageRegistries = hasScope("docker:registries:view");
  const canViewLicense = hasScope("license:view");
  const canManageLicense = hasScope("license:manage");
  const canViewStatusPage = hasScope("status-page:view");
  const canViewIntegrations =
    hasScope("integrations:gitlab:view") || hasScope("integrations:gitlab:manage");
  const canAccessGatewayTab =
    canViewGatewaySettings || canManageRegistries || canUpdate || canViewLicense;
  const canAccessFeaturesTab = canViewStatusPage || canViewHousekeeping;
  const availableTabs = useMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = [];
    if (canAccessGatewayTab) tabs.push("gateway");
    if (canAccessFeaturesTab) tabs.push("features");
    if (canViewIntegrations) tabs.push("integrations");
    if (canConfigInference) tabs.push("inference");
    if (canConfigAI) tabs.push("ai");
    return tabs;
  }, [
    canAccessFeaturesTab,
    canAccessGatewayTab,
    canConfigAI,
    canConfigInference,
    canViewIntegrations,
  ]);
  const currentTab = activeTab && availableTabs.includes(activeTab) ? activeTab : availableTabs[0];

  useEffect(() => {
    api
      .listNodes({ limit: 100 })
      .then((r) => setNodesList(r.data ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (canViewGatewaySettings) {
      api
        .getAuthProvisioningSettings()
        .then((data) => api.setCache("settings:auth-provisioning", data))
        .catch(() => {});
    }
    if (canManageRegistries) {
      api
        .listDockerRegistries()
        .then((data) => api.setCache("settings:docker-registries", data ?? []))
        .catch(() => {});
    }
    if (canViewLicense) {
      api
        .getLicenseStatus()
        .then((data) => api.setCache("settings:license-status", data))
        .catch(() => {});
    }
    if (canConfigAI) {
      api
        .getAIConfig()
        .then((data) => api.setCache("settings:ai-config", data))
        .catch(() => {});
    }
    if (canViewStatusPage) {
      api
        .getStatusPageSettings()
        .then((data) => api.setCache("settings:status-page-config", data))
        .catch(() => {});
      api
        .listStatusPageProxyTemplates()
        .then((data) => api.setCache("settings:status-page-proxy-templates", data ?? []))
        .catch(() => {});
      api
        .listSSLCertificates({ limit: 100 })
        .then((res) => api.setCache("settings:status-page-ssl-certs", res.data ?? []))
        .catch(() => {});
    }
    if (canViewHousekeeping) {
      api
        .getHousekeepingConfig()
        .then((data) => api.setCache("housekeeping:config", data))
        .catch(() => {});
      api
        .getHousekeepingStats()
        .then((data) => api.setCache("housekeeping:stats", data))
        .catch(() => {});
    }
    if (canViewIntegrations) {
      api
        .listGitLabConnectors()
        .then((data) => api.setCache("settings:gitlab-connectors", data ?? []))
        .catch(() => {});
    }
  }, [
    canConfigAI,
    canManageRegistries,
    canViewGatewaySettings,
    canViewHousekeeping,
    canViewIntegrations,
    canViewLicense,
    canViewStatusPage,
  ]);

  useEffect(() => {
    const firstTab = availableTabs[0];
    if (!firstTab) return;
    if (!tabParam || !isSettingsTab(tabParam) || !availableTabs.includes(tabParam)) {
      navigate(`/settings/${firstTab}`, { replace: true });
    }
  }, [availableTabs, navigate, tabParam]);

  const handleTabChange = (value: string) => {
    navigate(`/settings/${value}`);
  };

  if (!currentTab) return <Navigate to="/profile" replace />;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex items-center gap-3">
          <LiteModeBackButton />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-sm text-muted-foreground">Application and system settings</p>
          </div>
        </div>

        <Tabs value={currentTab} onValueChange={handleTabChange} className="flex flex-col">
          <TabsList className="shrink-0">
            {canAccessGatewayTab && (
              <TabsTrigger value="gateway" className="gap-1.5">
                <ServerCog className="h-3.5 w-3.5" />
                Gateway settings
              </TabsTrigger>
            )}
            {canAccessFeaturesTab && (
              <TabsTrigger value="features" className="gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                Features
              </TabsTrigger>
            )}
            {canViewIntegrations && (
              <TabsTrigger value="integrations" className="gap-1.5">
                <Plug className="h-3.5 w-3.5" />
                Integrations
              </TabsTrigger>
            )}
            {canConfigAI && (
              <TabsTrigger value="ai" className="gap-1.5">
                <Bot className="h-3.5 w-3.5" />
                AI Assistant
              </TabsTrigger>
            )}
            {canConfigInference && (
              <TabsTrigger value="inference" className="gap-1.5">
                <Network className="h-3.5 w-3.5" />
                Inference
              </TabsTrigger>
            )}
          </TabsList>

          {canAccessGatewayTab && (
            <TabsContent value="gateway" className="pb-0">
              <div className="space-y-4">
                {canViewGatewaySettings && (
                  <AuthProvisioningSection canEdit={canEditGatewaySettings} />
                )}

                {canManageRegistries && <DockerRegistriesSection nodesList={nodesList} />}

                {canViewLicense ? (
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                    {canUpdate && <UpdateSection canUpdate={canUpdate} />}
                    <LicenseSection canManage={canManageLicense} />
                  </div>
                ) : (
                  canUpdate && <UpdateSection canUpdate={canUpdate} />
                )}
              </div>
            </TabsContent>
          )}

          {canAccessFeaturesTab && (
            <TabsContent value="features" className="pb-0">
              <div className="space-y-4">
                {canViewStatusPage && <StatusPageSection nodesList={nodesList} />}

                {canViewHousekeeping && (
                  <HousekeepingSection
                    canRun={canRunHousekeeping}
                    canConfigure={canConfigureHousekeeping}
                  />
                )}
              </div>
            </TabsContent>
          )}

          {canViewIntegrations && (
            <TabsContent value="integrations" className="pb-0">
              <div className="space-y-4">
                <IntegrationsSection />
              </div>
            </TabsContent>
          )}

          {canConfigAI && (
            <TabsContent value="ai" className="pb-0">
              <div className="space-y-4">
                <AIConfigSection />
              </div>
            </TabsContent>
          )}
          {canConfigInference && (
            <TabsContent value="inference" className="pb-0">
              <InferenceSettingsSection />
            </TabsContent>
          )}
        </Tabs>

        <PoweredByFooter transitionKey={currentTab} />
      </div>
    </PageTransition>
  );
}
