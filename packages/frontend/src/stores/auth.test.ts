import { AUTH_CONTEXT_STORAGE_KEY, registerAuthContextReset, useAuthStore } from "@/stores/auth";
import type { User } from "@/types";

const USER: User = {
  id: "user-1",
  oidcSubject: "oidc-user-1",
  email: "user@example.com",
  name: "User",
  avatarUrl: null,
  groupId: "group-1",
  groupName: "Group",
  scopes: ["proxy:view"],
  isBlocked: false,
};

afterEach(() => {
  registerAuthContextReset(() => {});
  window.localStorage.removeItem(AUTH_CONTEXT_STORAGE_KEY);
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  });
});

describe("auth store session reset callback", () => {
  it("does not reset client state when hydrating the initial authenticated user", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);

    useAuthStore.getState().setUser(USER);
    expect(reset).not.toHaveBeenCalled();

    useAuthStore.getState().setUser({ ...USER });
    expect(reset).not.toHaveBeenCalled();
  });

  it("resets client state when initial hydration belongs to a different stored auth context", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    window.localStorage.setItem(AUTH_CONTEXT_STORAGE_KEY, "user-2:proxy:view:active");

    useAuthStore.getState().setUser(USER);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(AUTH_CONTEXT_STORAGE_KEY)).toBe("user-1:proxy:view:active");
  });

  it("runs when an existing authenticated identity or scopes change", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    useAuthStore.setState({ user: USER, isAuthenticated: true, isLoading: false });

    useAuthStore.getState().setUser({ ...USER, scopes: ["proxy:view:host-1"] });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith({ preserveShell: true });
  });
  it("does not preserve the shell when identity or blocked status changes", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    useAuthStore.setState({ user: USER, isAuthenticated: true, isLoading: false });
    useAuthStore.getState().setUser({ ...USER, isBlocked: true });
    expect(reset).toHaveBeenLastCalledWith({ preserveShell: false });
    useAuthStore.getState().setUser({ ...USER, id: "other" });
    expect(reset).toHaveBeenLastCalledWith({ preserveShell: false });
  });

  it("runs when logging out from an authenticated session", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    useAuthStore.setState({ user: USER, isAuthenticated: true, isLoading: false });

    useAuthStore.getState().logout();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(window.localStorage.getItem(AUTH_CONTEXT_STORAGE_KEY)).toBeNull();
  });

  it("runs when anonymous logout clears a stored auth context", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    window.localStorage.setItem(AUTH_CONTEXT_STORAGE_KEY, "user-2:proxy:view:active");

    useAuthStore.getState().logout();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(AUTH_CONTEXT_STORAGE_KEY)).toBeNull();
  });

  it("runs when login replaces an existing auth context", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);
    useAuthStore.setState({ user: USER, isAuthenticated: true, isLoading: false });

    useAuthStore.getState().login({ ...USER, id: "user-2", scopes: ["proxy:view:host-1"] });

    expect(reset).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user?.id).toBe("user-2");
  });

  it("does not reset when login starts from an anonymous context", () => {
    const reset = vi.fn();
    registerAuthContextReset(reset);

    useAuthStore.getState().login(USER);

    expect(reset).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user?.id).toBe(USER.id);
  });
});
