import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { refreshDynamicScopes } from "./live-scopes";

describe("refreshDynamicScopes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("skips the request for broad and per-resource grants", async () => {
    useAuthStore.setState({ user: makeUser({ scopes: ["databases:view", "storage:view:s1"] }) });
    const getCurrentUser = vi.spyOn(api, "getCurrentUser");

    await refreshDynamicScopes();

    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("applies the live scopes of folder and node grants", async () => {
    useAuthStore.setState({ user: makeUser({ scopes: ["databases:view:folder/f1"] }) });
    vi.spyOn(api, "getCurrentUser").mockResolvedValue(
      makeUser({ scopes: ["databases:view:folder/f1", "databases:view:db-new"] })
    );

    await refreshDynamicScopes();

    expect(useAuthStore.getState().user?.scopes).toEqual([
      "databases:view:folder/f1",
      "databases:view:db-new",
    ]);
  });

  it("keeps the cached scopes when the refresh fails", async () => {
    useAuthStore.setState({ user: makeUser({ scopes: ["storage:view:node/n1"] }) });
    vi.spyOn(api, "getCurrentUser").mockRejectedValue(new Error("offline"));

    await expect(refreshDynamicScopes()).resolves.toBeUndefined();
    expect(useAuthStore.getState().user?.scopes).toEqual(["storage:view:node/n1"]);
  });
});
