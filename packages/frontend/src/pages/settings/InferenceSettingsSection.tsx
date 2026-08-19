import { useState } from "react";
import { PanelShell } from "@/components/common/PanelShell";
import { useInferenceCoreStatus } from "@/hooks/use-inference-core-status";
import { useAuthStore } from "@/stores/auth";
import type { InferenceCoreStatus } from "@/types/inference-core";
import { InferenceActivityPanel } from "../inference/InferenceActivityPanel";
import { InferenceUsersTable } from "../inference/InferenceAdminTables";
import { InferenceOverview } from "../inference/InferenceUsagePanels";
import {
  InferenceCoreLifecyclePanel,
  inferenceCoreBlockedReason,
  isInferenceCoreReady,
} from "./inference/InferenceCoreLifecyclePanel";
import { InferenceEndpointSettingsPanel } from "./inference/InferenceEndpointSettingsPanel";
import { InferenceModelsPanel } from "./inference/InferenceModelsPanel";
import { InferenceProvidersPanel } from "./inference/InferenceProvidersPanel";

function CorePrerequisiteNotice({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status: InferenceCoreStatus | null;
}) {
  const reason =
    inferenceCoreBlockedReason(status) ??
    (status === null
      ? "The inference core status could not be loaded. Resolve the error above before configuring providers and models."
      : null);
  if (!reason) return null;
  return (
    <PanelShell title={title} description={description}>
      <p className="px-4 py-3 text-sm text-muted-foreground">{reason}</p>
    </PanelShell>
  );
}

export function InferenceSettingsSection() {
  const [providerRevision, setProviderRevision] = useState(0);
  const hasScope = useAuthStore((state) => state.hasScope);
  const canViewUsage = hasScope("inference:usage:view");
  const canViewProviders = hasScope("inference:providers:view");
  const canManageProviders = hasScope("inference:providers:manage");
  const canManageModels = hasScope("inference:models:manage");
  const canManageLimits = hasScope("inference:limits:manage");
  const core = useInferenceCoreStatus(canViewProviders);
  const coreReady = isInferenceCoreReady(core.status);
  // Until the core status is known, keep dependent panels hidden; the core
  // panel renders its own skeleton. Provider/model panels stay disabled with
  // an explanation unless the core is compatible and ready.
  const coreStatusKnown = core.status !== null || core.error !== null;
  return (
    <div className="space-y-4">
      {canViewProviders && (
        <InferenceCoreLifecyclePanel
          mode="settings"
          status={core.status}
          loading={core.loading}
          error={core.error}
          canManage={canManageProviders}
          onRefresh={core.refresh}
        />
      )}
      {canViewProviders && <InferenceEndpointSettingsPanel />}
      {canViewUsage && <InferenceOverview />}
      {canViewProviders &&
        coreStatusKnown &&
        (coreReady ? (
          <InferenceProvidersPanel
            onConnectionsChanged={() => setProviderRevision((value) => value + 1)}
          />
        ) : (
          <CorePrerequisiteNotice
            title="Providers"
            description="Connected accounts and API credentials. Higher connections are used first by Sequential routing; Balanced distributes evenly."
            status={core.status}
          />
        ))}
      {canManageModels &&
        (!canViewProviders || coreStatusKnown) &&
        (canViewProviders && !coreReady ? (
          <CorePrerequisiteNotice
            title="Models"
            description="Models exposed to users and the provider account group serving each model"
            status={core.status}
          />
        ) : (
          <InferenceModelsPanel refreshToken={providerRevision} />
        ))}
      {(canViewUsage || canManageLimits) && (
        <InferenceUsersTable canManage={canManageLimits} canViewUsage={canViewUsage} />
      )}
      {canViewUsage && <InferenceActivityPanel />}
    </div>
  );
}
