import { create } from "zustand";
import { applyForcedGatewayUpdateStatus } from "@/lib/dev-force-updates";
import { api } from "@/services/api";
import { useAppStatusStore } from "@/stores/app-status";
import type { UpdateStatus } from "@/types";

interface UpdateState {
  status: UpdateStatus | null;
  isChecking: boolean;
  isUpdating: boolean;

  fetchStatus: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  triggerUpdate: (version: string) => Promise<void>;
  clearUpdating: () => void;
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  status: null,
  isChecking: false,
  isUpdating: false,

  fetchStatus: async () => {
    try {
      const status = applyForcedGatewayUpdateStatus(await api.getVersionInfo());
      api.setCache("system:version", status);
      set({ status });
    } catch {
      // ignore
    }
  },

  checkForUpdates: async () => {
    set({ isChecking: true });
    try {
      const status = applyForcedGatewayUpdateStatus(await api.checkForUpdates());
      api.setCache("system:version", status);
      set({ status });
    } catch {
      // ignore
    } finally {
      set({ isChecking: false });
    }
  },

  triggerUpdate: async (version: string) => {
    set({ isUpdating: true });
    try {
      useAppStatusStore.getState().setGatewayUpdatingActive(true, version);
      await api.triggerUpdate(version);
    } catch (error) {
      useAppStatusStore
        .getState()
        .setGatewayUpdateError(
          error instanceof Error ? error.message : "Gateway update could not be started",
          version
        );
      set({ isUpdating: false });
    }
  },

  clearUpdating: () => set({ isUpdating: false }),
}));
