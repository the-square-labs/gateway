import { create } from "zustand";
import { api } from "@/services/api";
import type { DashboardBootstrap, DashboardBootstrapRequest } from "@/types";

interface DashboardBootstrapState {
  snapshot: DashboardBootstrap | null;
  key: string | null;
  request: DashboardBootstrapRequest | null;
  loading: boolean;
  error: boolean;
  load: (key: string, request: DashboardBootstrapRequest) => Promise<DashboardBootstrap | null>;
  invalidate: () => void;
  clear: () => void;
}

type InFlightRequest = {
  key: string;
  token: number;
  promise: Promise<DashboardBootstrap | null>;
};

let inFlight: InFlightRequest | null = null;
let pendingRefresh: { key: string; request: DashboardBootstrapRequest } | null = null;
let requestToken = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
let invalidationTimer: ReturnType<typeof setTimeout> | null = null;

const DASHBOARD_INVALIDATION_DEBOUNCE_MS = 250;

/**
 * The shell owns the request so Sidebar and Dashboard consume exactly the
 * same user-scoped snapshot.  Existing data remains visible while refreshes
 * run, which prevents the dashboard from flashing empty loading states.
 */
export const useDashboardBootstrapStore = create<DashboardBootstrapState>()((set, get) => ({
  snapshot: null,
  key: null,
  request: null,
  loading: false,
  error: false,
  load: async (key, request) => {
    if (inFlight?.key === key) return inFlight.promise;
    if (get().key === key && get().snapshot) return get().snapshot;
    // A new request supersedes any deferred refresh for the same old snapshot.
    pendingRefresh = null;
    set({ loading: !get().snapshot, request, error: false });
    const token = ++requestToken;
    const promise = api
      .getDashboardBootstrap(request)
      .then((snapshot) => {
        if (token === requestToken) {
          retryAttempts = 0;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          set({ snapshot, key, loading: false, error: false });
        }
        return snapshot;
      })
      .catch(() => {
        if (token === requestToken) {
          set({ key, loading: false });
          if (!get().snapshot && retryAttempts < 3 && !retryTimer) {
            const delay = 1_000 * 2 ** retryAttempts++;
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (get().key !== key || get().request !== request || get().snapshot) return;
              set({ key: null });
              void get().load(key, request);
            }, delay);
          } else if (!get().snapshot) {
            set({ error: true });
          }
        }
        return get().snapshot;
      })
      .finally(() => {
        if (inFlight?.token !== token) return;
        inFlight = null;
        const refresh = pendingRefresh;
        pendingRefresh = null;
        if (refresh && get().request === refresh.request) {
          set({ key: null });
          void get().load(refresh.key, refresh.request);
        }
      });
    inFlight = { key, token, promise };
    return promise;
  },
  invalidate: () => {
    if (invalidationTimer) return;
    invalidationTimer = setTimeout(() => {
      invalidationTimer = null;
      const { key, request } = get();
      const refreshKey = key ?? inFlight?.key;
      if (!refreshKey || !request) return;
      if (inFlight?.key === refreshKey) {
        // The in-flight response may predate this event. Ignore it and fetch again once it settles.
        pendingRefresh = { key: refreshKey, request };
        requestToken += 1;
        set({ key: null });
        return;
      }
      set({ key: null });
      void get().load(refreshKey, request);
    }, DASHBOARD_INVALIDATION_DEBOUNCE_MS);
  },
  clear: () => {
    inFlight = null;
    pendingRefresh = null;
    requestToken += 1;
    retryAttempts = 0;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (invalidationTimer) clearTimeout(invalidationTimer);
    invalidationTimer = null;
    set({ snapshot: null, key: null, request: null, loading: false, error: false });
  },
}));
