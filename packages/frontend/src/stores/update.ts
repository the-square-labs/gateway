import { create } from "zustand";
import { applyForcedGatewayUpdateStatus } from "@/lib/dev-force-updates";
import {
  isGatewayUpdateTargetVersion,
  publishGatewayReload,
  reloadGatewayClient,
} from "@/lib/gateway-update-reload";
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

export const useUpdateStore = create<UpdateState>()((set, get) => ({
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
      // Poll for completion
      const currentVersion = get().status?.currentVersion;
      const poll = setInterval(async () => {
        try {
          const status = await api.getVersionInfo();
          if (
            (currentVersion && status.currentVersion !== currentVersion) ||
            isGatewayUpdateTargetVersion(status.currentVersion, version)
          ) {
            clearInterval(poll);
            const reload = publishGatewayReload(status.currentVersion, "gateway-update-complete");
            reloadGatewayClient(reload.id);
          }
        } catch {
          // App still down
        }
      }, 3000);
      // Safety timeout
      setTimeout(() => {
        clearInterval(poll);
        set((s) => {
          if (s.isUpdating) return { isUpdating: false };
          return s;
        });
      }, 300_000);
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
