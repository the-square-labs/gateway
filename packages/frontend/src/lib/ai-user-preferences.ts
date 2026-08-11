import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useUIStore } from "@/stores/ui";
import type { AIApprovalMode } from "./ai-approval-mode";

const USER_PREFERENCES_CACHE_KEY = "auth:me:preferences";
let aiApprovalModeRequestId = 0;

export async function confirmBypassEverythingMode(): Promise<boolean> {
  return confirm({
    title: "Enable AI bypass delete approvals?",
    description:
      "AI Workspace will create, modify, and delete resources without asking for your confirmation.",
    confirmLabel: "Enable",
    variant: "destructive",
  });
}

export async function updateAIApprovalModeOptimistically(
  mode: AIApprovalMode,
  previousMode = useUIStore.getState().aiApprovalMode
): Promise<void> {
  const requestId = ++aiApprovalModeRequestId;
  const { setAIApprovalMode } = useUIStore.getState();
  setAIApprovalMode(mode);
  api.setCache(USER_PREFERENCES_CACHE_KEY, { aiApprovalMode: mode });

  try {
    await api.updateUserPreferences({ aiApprovalMode: mode });
  } catch (error) {
    if (requestId === aiApprovalModeRequestId && useUIStore.getState().aiApprovalMode === mode) {
      setAIApprovalMode(previousMode);
      api.setCache(USER_PREFERENCES_CACHE_KEY, { aiApprovalMode: previousMode });
    }
    throw error;
  }
}
