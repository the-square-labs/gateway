import { AlertTriangle, Plus, Send, ShieldCheck, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertsTab } from "@/pages/notifications/AlertsTab";
import { DELIVERY_PAGE_SIZE, DeliveryLogTab } from "@/pages/notifications/DeliveryLogTab";
import {
  SIEM_DELIVERY_PAGE_SIZE,
  SiemDeliveryLogTab,
} from "@/pages/notifications/SiemDeliveryLogTab";
import {
  SIEM_DESTINATION_CACHE_KEY,
  SiemDestinationsTab,
} from "@/pages/notifications/SiemDestinationsTab";
import { WebhooksTab } from "@/pages/notifications/WebhooksTab";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";

const TABS = [
  { value: "alerts", label: "Alerts", icon: AlertTriangle },
  { value: "webhooks", label: "Webhooks", icon: Webhook },
  { value: "deliveries", label: "Delivery Log", icon: Send },
  { value: "siem", label: "SIEM", icon: ShieldCheck },
  { value: "siem-deliveries", label: "SIEM Delivery Log", icon: Send },
] as const;

export function Notifications() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasAnyScope } = useAuthStore();
  const siemEnabled = useSystemConfigStore((state) => state.config.features.siemEnabled);
  const canReadAlerts = hasAnyScope(
    "notifications:alerts:view",
    "notifications:alerts:view",
    "notifications:view",
    "notifications:manage"
  );
  const canAccessAlerts = hasAnyScope(
    "notifications:alerts:view",
    "notifications:alerts:view",
    "notifications:alerts:create",
    "notifications:alerts:edit",
    "notifications:alerts:delete",
    "notifications:view",
    "notifications:manage"
  );
  const canReadWebhooks = hasAnyScope(
    "notifications:webhooks:view",
    "notifications:webhooks:view",
    "notifications:view",
    "notifications:manage"
  );
  const canManageAlerts = hasAnyScope(
    "notifications:alerts:create",
    "notifications:alerts:edit",
    "notifications:alerts:delete",
    "notifications:manage"
  );
  const canAccessWebhooks = hasAnyScope(
    "notifications:webhooks:view",
    "notifications:webhooks:view",
    "notifications:webhooks:create",
    "notifications:webhooks:edit",
    "notifications:webhooks:delete",
    "notifications:view",
    "notifications:manage"
  );
  const canManageWebhooks = hasAnyScope(
    "notifications:webhooks:create",
    "notifications:webhooks:edit",
    "notifications:webhooks:delete",
    "notifications:manage"
  );
  const canViewDeliveries = hasAnyScope(
    "notifications:deliveries:view",
    "notifications:deliveries:view",
    "notifications:view",
    "notifications:manage"
  );
  const canViewSiem = siemEnabled && hasAnyScope("audit:siem:view", "audit:siem:manage");
  const canManageSiem = siemEnabled && hasAnyScope("audit:siem:manage");
  const visibleTabs = TABS.filter((tab) => {
    if (tab.value === "alerts") return canAccessAlerts;
    if (tab.value === "webhooks") return canAccessWebhooks;
    if (tab.value === "deliveries") return canViewDeliveries;
    if (tab.value === "siem") return canViewSiem;
    if (tab.value === "siem-deliveries") return canViewSiem;
    return false;
  });
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "alerts";
  const [openCreateAlertToken, setOpenCreateAlertToken] = useState(0);
  const [openCreateWebhookToken, setOpenCreateWebhookToken] = useState(0);
  const [refreshDeliveriesToken, setRefreshDeliveriesToken] = useState(0);
  const [openCreateSiemToken, setOpenCreateSiemToken] = useState(0);
  const [refreshSiemDeliveriesToken, setRefreshSiemDeliveriesToken] = useState(0);

  useEffect(() => {
    if (canReadAlerts) {
      api
        .listAlertRules({ limit: 100 })
        .then((result) => api.setCache("notifications:alerts", result.data ?? []))
        .catch(() => {});
    }
    if (canReadWebhooks) {
      api
        .listWebhooks({ limit: 100 })
        .then((result) => api.setCache("notifications:webhooks", result.data ?? []))
        .catch(() => {});
    }
    if (canViewDeliveries) {
      api
        .listDeliveries({ page: 1, limit: DELIVERY_PAGE_SIZE })
        .then((result) => {
          api.setCache("notifications:deliveries:all", result.data ?? []);
          api.setCache("notifications:deliveries:all:has-more", (result.totalPages ?? 1) > 1);
        })
        .catch(() => {});
    }
    if (canViewSiem) {
      api
        .listSiemDestinations({ limit: 100 })
        .then((result) => api.setCache(SIEM_DESTINATION_CACHE_KEY, result.data ?? []))
        .catch(() => {});
      api
        .listSiemDeliveries({ page: 1, limit: SIEM_DELIVERY_PAGE_SIZE })
        .then((result) => {
          api.setCache("audit:siem:deliveries:all", result.data ?? []);
          api.setCache("audit:siem:deliveries:all:has-more", (result.totalPages ?? 1) > 1);
        })
        .catch(() => {});
    }
  }, [canReadAlerts, canReadWebhooks, canViewDeliveries, canViewSiem]);

  const headerAction =
    activeTab === "alerts" && canManageAlerts ? (
      <Button onClick={() => setOpenCreateAlertToken((v) => v + 1)}>
        <Plus className="h-4 w-4" /> New Alert
      </Button>
    ) : activeTab === "webhooks" && canManageWebhooks ? (
      <Button onClick={() => setOpenCreateWebhookToken((v) => v + 1)}>
        <Plus className="h-4 w-4" /> New Webhook
      </Button>
    ) : activeTab === "deliveries" && canViewDeliveries ? (
      <Button variant="outline" onClick={() => setRefreshDeliveriesToken((v) => v + 1)}>
        Refresh
      </Button>
    ) : activeTab === "siem" && canManageSiem ? (
      <Button onClick={() => setOpenCreateSiemToken((v) => v + 1)}>
        <Plus className="h-4 w-4" /> New SIEM Destination
      </Button>
    ) : activeTab === "siem-deliveries" && canViewSiem ? (
      <Button variant="outline" onClick={() => setRefreshSiemDeliveriesToken((v) => v + 1)}>
        Refresh
      </Button>
    ) : null;
  const headerActions =
    activeTab === "alerts" && canManageAlerts
      ? [
          {
            label: "New Alert",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => setOpenCreateAlertToken((v) => v + 1),
          },
        ]
      : activeTab === "webhooks" && canManageWebhooks
        ? [
            {
              label: "New Webhook",
              icon: <Plus className="h-4 w-4" />,
              onClick: () => setOpenCreateWebhookToken((v) => v + 1),
            },
          ]
        : activeTab === "deliveries" && canViewDeliveries
          ? [
              {
                label: "Refresh",
                onClick: () => setRefreshDeliveriesToken((v) => v + 1),
              },
            ]
          : activeTab === "siem" && canManageSiem
            ? [
                {
                  label: "New SIEM Destination",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: () => setOpenCreateSiemToken((v) => v + 1),
                },
              ]
            : activeTab === "siem-deliveries" && canViewSiem
              ? [
                  {
                    label: "Refresh",
                    onClick: () => setRefreshSiemDeliveriesToken((v) => v + 1),
                  },
                ]
              : [];

  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (!tabParam || !visibleTabs.some((t) => t.value === tabParam)) {
      navigate(`/notifications/${activeTab}`, { replace: true });
    }
  }, [activeTab, navigate, tabParam, visibleTabs]);

  const usesFillLayout = activeTab === "deliveries" || activeTab === "siem-deliveries";

  return (
    <div
      className={
        usesFillLayout
          ? "h-full flex flex-col overflow-hidden p-6 gap-6"
          : "h-full overflow-y-auto p-6 space-y-6"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <LiteModeBackButton />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Notifications</h1>
            <p className="text-sm text-muted-foreground">
              {siemEnabled
                ? "Manage alert rules, webhooks, SIEM audit export, and delivery activity"
                : "Manage alert rules, webhooks, and delivery activity"}
            </p>
          </div>
        </div>
        <ResponsiveHeaderActions actions={headerActions}>{headerAction}</ResponsiveHeaderActions>
      </div>
      <Tabs
        value={activeTab}
        onValueChange={(v) => navigate(`/notifications/${v}`, { replace: true })}
        className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
      >
        <TabsList>
          {visibleTabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex items-center gap-2">
              <t.icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {canAccessAlerts && (
          <TabsContent value="alerts" className="mt-4">
            <AlertsTab
              canManage={canManageAlerts}
              canRead={canReadAlerts}
              openCreateToken={openCreateAlertToken}
            />
          </TabsContent>
        )}
        {canAccessWebhooks && (
          <TabsContent value="webhooks" className="mt-4">
            <WebhooksTab
              canManage={canManageWebhooks}
              canRead={canReadWebhooks}
              openCreateToken={openCreateWebhookToken}
            />
          </TabsContent>
        )}
        {canViewDeliveries && (
          <TabsContent
            value="deliveries"
            className="mt-4 flex flex-col flex-1 min-h-0 overflow-hidden"
          >
            <DeliveryLogTab refreshToken={refreshDeliveriesToken} />
          </TabsContent>
        )}
        {canViewSiem && (
          <TabsContent value="siem" className="mt-4">
            <SiemDestinationsTab
              canManage={canManageSiem}
              canRead={canViewSiem}
              openCreateToken={openCreateSiemToken}
              onViewDeliveryLog={(destination) =>
                navigate(
                  `/notifications/siem-deliveries?destinationId=${encodeURIComponent(destination.id)}`
                )
              }
            />
          </TabsContent>
        )}
        {canViewSiem && (
          <TabsContent
            value="siem-deliveries"
            className="mt-4 flex flex-col flex-1 min-h-0 overflow-hidden"
          >
            <SiemDeliveryLogTab
              canManage={canManageSiem}
              initialDestinationId={searchParams.get("destinationId")}
              onDestinationFilterChange={(destinationId) => {
                setSearchParams(
                  (current) => {
                    const next = new URLSearchParams(current);
                    if (destinationId) next.set("destinationId", destinationId);
                    else next.delete("destinationId");
                    return next;
                  },
                  { replace: true }
                );
              }}
              refreshToken={refreshSiemDeliveriesToken}
            />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
