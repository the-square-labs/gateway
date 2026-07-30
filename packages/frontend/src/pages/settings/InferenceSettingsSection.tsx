import { useState } from "react";
import { useAuthStore } from "@/stores/auth";
import { InferenceActivityPanel } from "../inference/InferenceActivityPanel";
import { InferenceUsersTable } from "../inference/InferenceAdminTables";
import { InferenceOverview } from "../inference/InferenceUsagePanels";
import { InferenceEndpointSettingsPanel } from "./inference/InferenceEndpointSettingsPanel";
import { InferenceModelsPanel } from "./inference/InferenceModelsPanel";
import { InferenceProvidersPanel } from "./inference/InferenceProvidersPanel";

export function InferenceSettingsSection() {
  const [providerRevision, setProviderRevision] = useState(0);
  const hasScope = useAuthStore((state) => state.hasScope);
  const canViewUsage = hasScope("inference:usage:view");
  const canViewProviders = hasScope("inference:providers:view");
  const canManageProviders = hasScope("inference:providers:manage");
  const canManageModels = hasScope("inference:models:manage");
  const canManageLimits = hasScope("inference:limits:manage");
  return (
    <div className="space-y-4">
      {canViewProviders && <InferenceEndpointSettingsPanel canManage={canManageProviders} />}
      {canViewUsage && <InferenceOverview />}
      {canViewProviders && (
        <InferenceProvidersPanel
          onConnectionsChanged={() => setProviderRevision((value) => value + 1)}
        />
      )}
      {canManageModels && <InferenceModelsPanel refreshToken={providerRevision} />}
      {(canViewUsage || canManageLimits) && (
        <InferenceUsersTable canManage={canManageLimits} canViewUsage={canViewUsage} />
      )}
      {canViewUsage && <InferenceActivityPanel />}
    </div>
  );
}
