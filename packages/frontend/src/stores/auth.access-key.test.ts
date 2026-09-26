import { beforeEach, describe, expect, it } from "vitest";
import { makeUser } from "@/test/fixtures";
import { accessContextKey, useAuthStore } from "./auth";

describe("access context key", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, accessEpoch: 0 });
  });

  it("stays the same when live scopes only widen", () => {
    useAuthStore.getState().setUser(makeUser({ id: "one", scopes: ["proxy:view:folder/f1"] }));
    const before = accessContextKey(useAuthStore.getState());
    useAuthStore.getState().applyLiveScopes(["proxy:view:folder/f1", "proxy:view:host-1"]);
    expect(useAuthStore.getState().user?.scopes).toContain("proxy:view:host-1");
    expect(accessContextKey(useAuthStore.getState())).toBe(before);
  });

  it("changes when a grant is lost or the user changes", () => {
    useAuthStore
      .getState()
      .setUser(makeUser({ id: "one", scopes: ["proxy:view", "nodes:details"] }));
    const first = accessContextKey(useAuthStore.getState());
    useAuthStore.getState().applyLiveScopes(["proxy:view"]);
    const narrowed = accessContextKey(useAuthStore.getState());
    expect(narrowed).not.toBe(first);
    useAuthStore.getState().setUser(makeUser({ id: "two", scopes: ["proxy:view"] }));
    expect(accessContextKey(useAuthStore.getState())).not.toBe(narrowed);
  });
});
