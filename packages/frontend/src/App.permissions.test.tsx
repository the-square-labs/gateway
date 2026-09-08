import { act, render, waitFor } from "@testing-library/react";
import { RealtimeBridge } from "@/App";
import { api } from "@/services/api";
import type { UserPreferences } from "@/services/api-auth";
import { eventStream } from "@/services/event-stream";
import { registerAuthContextReset, useAuthStore } from "@/stores/auth";
import { resetClientSessionState } from "@/stores/session-reset";
import { useUIStore } from "@/stores/ui";
import { makeUser } from "@/test/fixtures";
import { AI_SCOPE } from "@/types";

vi.mock("@/stores/ai.store-lifecycle", () => ({
  installAIStoreLifecycle: vi.fn(),
}));

const preferences: UserPreferences = {
  aiApprovalMode: "normal",
  preferredInterface: "ai_workspace",
  preferredInterfaceSelectedAt: null,
};

beforeEach(() => {
  vi.spyOn(eventStream, "start").mockImplementation(() => {});
  vi.spyOn(eventStream, "stop").mockImplementation(() => {});
  vi.spyOn(eventStream, "subscribe").mockImplementation(() => () => {});
  vi.spyOn(eventStream, "onReconnect").mockImplementation(() => () => {});
  registerAuthContextReset(resetClientSessionState);
  // Each test starts a fresh session; warm preferences intentionally survive scope refreshes now.
  resetClientSessionState();
  useAuthStore.getState().login(makeUser({ scopes: [AI_SCOPE, "proxy:view"] }));
});

afterEach(() => {
  registerAuthContextReset(() => {});
  vi.restoreAllMocks();
});

async function changePermissions(scopes: string[]) {
  const user = useAuthStore.getState().user!;
  vi.spyOn(api, "getCurrentUser").mockResolvedValue({ ...user, scopes });
  const callback = vi
    .mocked(eventStream.subscribe)
    .mock.calls.find(([channel]) => channel === `permissions.changed.${user.id}`)?.[1];
  expect(callback).toBeDefined();
  await act(async () => {
    await callback!({});
  });
}

describe("live permission updates and interface preferences", () => {
  it.each([
    ["grant", [AI_SCOPE, "proxy:view", "nodes:details"]],
    ["revoke", [AI_SCOPE]],
  ])("reloads interface preferences after a permission %s for the same user", async (_, scopes) => {
    const getPreferences = vi.spyOn(api, "getUserPreferences").mockResolvedValue(preferences);
    render(<RealtimeBridge />);
    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));
    api.setCache("sensitive", { secret: true });

    await changePermissions(scopes);

    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(2));
    expect(useAuthStore.getState().user?.scopes).toEqual(scopes);
    expect(api.getCached("sensitive")).toBeUndefined();
    expect(useUIStore.getState()).toMatchObject({
      interfacePreferenceLoaded: true,
      preferredInterface: "ai_workspace",
      aiLiteMode: true,
    });
  });

  it("keeps the current interface when background preference revalidation fails", async () => {
    vi.spyOn(api, "getUserPreferences")
      .mockResolvedValueOnce(preferences)
      .mockRejectedValueOnce(new Error("Preferences unavailable"));
    render(<RealtimeBridge />);
    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));

    await changePermissions([AI_SCOPE]);

    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));
    expect(useUIStore.getState().preferredInterface).toBe("ai_workspace");
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
  it.each([
    ["grant", [AI_SCOPE, "proxy:view", "nodes:details"]],
    ["revoke", [AI_SCOPE]],
  ])("keeps a loaded shell visible during a slow permission %s refresh while clearing private cache", async (_, scopes) => {
    let resolve!: (value: UserPreferences) => void;
    vi.spyOn(api, "getUserPreferences")
      .mockResolvedValueOnce(preferences)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      );
    render(<RealtimeBridge />);
    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));
    api.setCache("sensitive", { secret: true });
    await changePermissions(scopes);
    expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true);
    expect(useUIStore.getState().preferredInterface).toBe("ai_workspace");
    expect(api.getCached("sensitive")).toBeUndefined();
    await act(async () => resolve(preferences));
  });

  it("discards an in-flight preference response from the previous permission context", async () => {
    // This scenario starts before any interface preference has loaded.
    useUIStore.getState().beginInterfacePreferenceLoad();
    let resolvePrevious!: (value: UserPreferences) => void;
    const getPreferences = vi
      .spyOn(api, "getUserPreferences")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePrevious = resolve;
          })
      )
      .mockResolvedValueOnce({ ...preferences, preferredInterface: "operations_console" });
    render(<RealtimeBridge />);
    await waitFor(() => expect(getPreferences).toHaveBeenCalledTimes(1));

    await changePermissions([AI_SCOPE]);
    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));
    await act(async () => {
      resolvePrevious(preferences);
    });

    expect(useUIStore.getState().preferredInterface).toBe("operations_console");
    expect(useUIStore.getState().aiLiteMode).toBe(false);
  });

  it("keeps preferences loaded when refreshed permissions are unchanged or reordered", async () => {
    const getPreferences = vi.spyOn(api, "getUserPreferences").mockResolvedValue(preferences);
    render(<RealtimeBridge />);
    await waitFor(() => expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true));

    await changePermissions(["proxy:view", AI_SCOPE]);

    expect(getPreferences).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().interfacePreferenceLoaded).toBe(true);
    expect(useUIStore.getState().preferredInterface).toBe("ai_workspace");
  });
});
