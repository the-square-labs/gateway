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

function withoutCachedAttention(snapshot: DashboardBootstrap): DashboardBootstrap {
  return {
    ...snapshot,
    attention: { severity: null, notices: [] },
  };
}

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
    const persistentKey = `dashboard:bootstrap:${key}`;
    const cached = api.getCached<DashboardBootstrap>(persistentKey, Number.POSITIVE_INFINITY);
    if (!get().snapshot && cached) {
      // Keep cached dashboard content for an instant paint, but never present a
      // persisted health/attention state as current. The live response below
      // restores the indicator after the server has re-evaluated all notices.
      set({
        snapshot: withoutCachedAttention(cached),
        key,
        request,
        loading: false,
        error: false,
      });
    }
    // A new request supersedes any deferred refresh for the same old snapshot.
    pendingRefresh = null;
    set({ loading: !get().snapshot, request, error: false });
    const token = ++requestToken;
    const promise = api
      .getDashboardBootstrap(request)
      .then((snapshot) => {
        if (token === requestToken) {
          api.setCache(persistentKey, snapshot);
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
