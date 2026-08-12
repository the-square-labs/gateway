import { create } from "zustand";
import { api } from "@/services/api";
import type { UIBootstrapShell } from "@/types";

interface UIBootstrapState {
  snapshot: UIBootstrapShell | null;
  loading: boolean;
  error: boolean;
  load: (key: string) => Promise<UIBootstrapShell | null>;
  invalidate: () => void;
  clear: () => void;
}

let currentKey: string | null = null;
let inFlight: Promise<UIBootstrapShell | null> | null = null;
let requestVersion = 0;
let refreshQueued = false;

/** Session shell data is shared by layout and routes and survives revalidation. */
export const useUIBootstrapStore = create<UIBootstrapState>()((set, get) => ({
  snapshot: null,
  loading: false,
  error: false,
  load: async (key) => {
    if (currentKey === key && get().snapshot) return get().snapshot;
    if (currentKey === key && inFlight) return inFlight;
    currentKey = key;
    const cached = api.getCached<{ data: UIBootstrapShell }>(
      "req:/api/ui/bootstrap",
      Number.POSITIVE_INFINITY
    )?.data;
    if (!get().snapshot && cached) {
      set({ snapshot: cached, loading: false, error: false });
    }
    const version = ++requestVersion;
    set({ loading: !get().snapshot, error: false });
    const request = api
      .getUIBootstrap()
      .then((snapshot) => {
        if (currentKey === key && version === requestVersion) {
          set({ snapshot, loading: false, error: false });
        }
        return snapshot;
      })
      .catch(() => {
        if (currentKey === key && version === requestVersion) {
          set({ loading: false, error: !get().snapshot });
        }
        return get().snapshot;
      })
      .finally(() => {
        if (version === requestVersion) {
          inFlight = null;
        }
      });
    inFlight = request;
    return request;
  },
  invalidate: () => {
    if (!currentKey) return;
    const key = currentKey;
    requestVersion += 1;
    currentKey = null;
    if (inFlight) {
      refreshQueued = true;
      void inFlight.finally(() => {
        if (!refreshQueued || currentKey !== null) return;
        refreshQueued = false;
        void get().load(key);
      });
      return;
    }
    void get().load(key);
  },
  clear: () => {
    requestVersion += 1;
    currentKey = null;
    inFlight = null;
    refreshQueued = false;
    set({ snapshot: null, loading: false, error: false });
  },
}));
