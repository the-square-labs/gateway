import { Award, FileCode, Plus } from "lucide-react";
import { useRef } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { NginxTemplates } from "./NginxTemplates";
import { Templates } from "./Templates";

const TABS = [
  {
    value: "pki",
    label: "PKI Certificates",
    icon: Award,
    scope: "pki:templates:view",
    createScope: "pki:templates:create",
  },
  {
    value: "nginx",
    label: "Nginx Config",
    icon: FileCode,
    scope: "proxy:templates:view",
    createScope: "proxy:templates:create",
  },
] as const;

export function TemplatesPage() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess } = useAuthStore();
  const pkiEnabled = useSystemConfigStore((s) => s.config.features.pkiEnabled);

  const pkiCreateRef = useRef<(() => void) | null>(null);
  const nginxCreateRef = useRef<(() => void) | null>(null);

  const visibleTabs = TABS.filter((t) => {
    if (t.value === "pki" && !pkiEnabled) return false;
    return hasScopedAccess(t.scope);
  });
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "pki";

  if (visibleTabs.length === 0) {
    return <Navigate to="/" replace />;
  }

  const handleTabChange = (value: string) => {
    navigate(`/templates/${value}`, { replace: true });
  };

  const renderActions = () => {
    const tab = TABS.find((t) => t.value === activeTab);
    if (!tab || !hasScope(tab.createScope)) return null;

    switch (activeTab) {
      case "pki":
        return (
          <Button onClick={() => pkiCreateRef.current?.()}>
            <Plus className="h-4 w-4 mr-1" />
            Create Template
          </Button>
        );
      case "nginx":
        return (
          <Button onClick={() => nginxCreateRef.current?.()}>
            <Plus className="h-4 w-4 mr-1" />
            Create Template
          </Button>
        );
      default:
        return null;
    }
  };
  const headerActions =
    activeTab === "pki" && hasScope("pki:templates:create")
      ? [
          {
            label: "Create Template",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => pkiCreateRef.current?.(),
          },
        ]
      : activeTab === "nginx" && hasScope("proxy:templates:create")
        ? [
            {
              label: "Create Template",
              icon: <Plus className="h-4 w-4" />,
              onClick: () => nginxCreateRef.current?.(),
            },
          ]
        : [];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Templates</h1>
              <p className="text-sm text-muted-foreground">
                Certificate and nginx configuration templates
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions actions={headerActions}>
            {renderActions()}
          </ResponsiveHeaderActions>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col">
          {pkiEnabled && (
            <TabsList className="shrink-0">
              {visibleTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                  <tab.icon className="h-3.5 w-3.5" />
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          )}

          {visibleTabs.some((tab) => tab.value === "pki") && (
            <TabsContent value="pki">
              <Templates
                embedded
                onCreateRef={(fn) => {
                  pkiCreateRef.current = fn;
                }}
              />
            </TabsContent>
          )}
          {visibleTabs.some((tab) => tab.value === "nginx") && (
            <TabsContent value="nginx">
              <NginxTemplates
                embedded
                onCreateRef={(fn) => {
                  nginxCreateRef.current = fn;
                }}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PageTransition>
  );
}
