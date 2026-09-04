import { create } from "zustand";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";
import { useUIStore } from "@/stores/ui";
import type { User } from "@/types";

type AuthContextResetCallback = () => void;

let authContextResetCallback: AuthContextResetCallback | null = null;
export const AUTH_CONTEXT_STORAGE_KEY = "gateway-auth-context-key";

export function registerAuthContextReset(callback: AuthContextResetCallback) {
  authContextResetCallback = callback;
}

export function authContextKey(user: User | null): string {
  if (!user) return "anonymous";
  return `${user.id}:${[...user.scopes].sort().join(",")}:${user.isBlocked ? "blocked" : "active"}`;
}

function getStoredAuthContextKey(): string | null {
  try {
    return window.localStorage.getItem(AUTH_CONTEXT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredAuthContextKey(key: string): void {
  try {
    window.localStorage.setItem(AUTH_CONTEXT_STORAGE_KEY, key);
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

function clearStoredAuthContextKey(): void {
  try {
    window.localStorage.removeItem(AUTH_CONTEXT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in private or embedded contexts.
  }
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User) => void;
  logout: () => void;
  hasScope: (scope: string) => boolean;
  hasScopedAccess: (scopeBase: string) => boolean;
  hasAnyScope: (...scopes: string[]) => boolean;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  setUser: (user) => {
    const currentUser = get().user;
    if (!user) {
      if (currentUser) {
        authContextResetCallback?.();
      }
      clearStoredAuthContextKey();
    } else {
      const nextKey = authContextKey(user);
      const currentKey = currentUser ? authContextKey(currentUser) : getStoredAuthContextKey();
      if (currentKey && currentKey !== nextKey) {
        authContextResetCallback?.();
      }
      setStoredAuthContextKey(nextKey);
      if (user.aiApprovalMode) useUIStore.getState().hydrateAIApprovalMode(user.aiApprovalMode);
    }
    set({
      user,
      isAuthenticated: !!user,
    });
  },

  setLoading: (isLoading) => set({ isLoading }),

  login: (user) => {
    const currentUser = get().user;
    const nextKey = authContextKey(user);
    const currentKey = currentUser ? authContextKey(currentUser) : getStoredAuthContextKey();
    if (currentKey && currentKey !== nextKey) {
      authContextResetCallback?.();
    }
    setStoredAuthContextKey(nextKey);
    if (user.aiApprovalMode) useUIStore.getState().hydrateAIApprovalMode(user.aiApprovalMode);
    set({
      user,
      isAuthenticated: true,
      isLoading: false,
    });
  },

  logout: () => {
    const hasStoredContext = !!getStoredAuthContextKey();
    if (get().user || get().isAuthenticated || hasStoredContext) {
      authContextResetCallback?.();
    }
    clearStoredAuthContextKey();
    set({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  hasScope: (scope) => {
    const user = get().user;
    if (!user) return false;
    return scopeMatches(user.scopes, scope);
  },

  hasScopedAccess: (scopeBase) => {
    const user = get().user;
    if (!user) return false;
    return hasScopeBase(user.scopes, scopeBase);
  },

  hasAnyScope: (...scopes) => {
    const user = get().user;
    if (!user) return false;
    return scopes.some((s) => scopeMatches(user.scopes, s));
  },
}));
