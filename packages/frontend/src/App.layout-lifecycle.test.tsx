import { act, render, screen } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { expect, it, vi } from "vitest";
import App from "@/App";
import { api } from "@/services/api";
import { eventStream } from "@/services/event-stream";
import { registerAuthContextReset, useAuthStore } from "@/stores/auth";
import { resetClientSessionState } from "@/stores/session-reset";
import { makeUser } from "@/test/fixtures";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: () => (
    <div data-testid="shell">
      <input aria-label="Shell state" defaultValue="retained" />
      <Outlet />
    </div>
  ),
}));
vi.mock("@/pages/AdminNodes", () => ({ AdminNodes: () => <div>Nodes content</div> }));
vi.mock("@/components/common/AppStatusGate", () => ({
  AppStatusGate: () => null,
  clearMaintenanceAutoReloadGuard: () => {},
}));
vi.mock("@/stores/ai.store-lifecycle", () => ({ installAIStoreLifecycle: vi.fn() }));
it("retains the DashboardLayout instance for scope changes but replaces it for another user", async () => {
  vi.spyOn(eventStream, "start").mockImplementation(() => {});
  vi.spyOn(eventStream, "stop").mockImplementation(() => {});
  vi.spyOn(eventStream, "subscribe").mockImplementation(() => () => {});
  vi.spyOn(eventStream, "onReconnect").mockImplementation(() => () => {});
  vi.spyOn(api, "getUserPreferences").mockResolvedValue({
    aiApprovalMode: "normal",
    preferredInterface: "operations_console",
    preferredInterfaceSelectedAt: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ lifecycleState: "running", data: { state: "ready" } }), {
          status: 200,
        })
    )
  );
  window.history.replaceState(null, "", "/nodes");
  registerAuthContextReset(resetClientSessionState);
  const user = makeUser({ id: "one", scopes: ["nodes:details"] });
  useAuthStore.setState({ user, isAuthenticated: true, isLoading: false });
  const result = render(<App />);
  const shell = await screen.findByTestId("shell");
  const input = screen.getByRole("textbox", { name: "Shell state" }) as HTMLInputElement;
  input.value = "custom";
  await act(async () =>
    useAuthStore.getState().setUser({ ...user, scopes: ["nodes:details", "proxy:view"] })
  );
  expect(screen.getByTestId("shell")).toBe(shell);
  expect(input.value).toBe("custom");
  await act(async () => useAuthStore.getState().setUser({ ...user, scopes: ["nodes:details"] }));
  expect(screen.getByTestId("shell")).toBe(shell);
  await act(async () => useAuthStore.getState().setUser({ ...user, id: "two" }));
  expect(screen.getByTestId("shell")).not.toBe(shell);
  result.unmount();
  registerAuthContextReset(() => {});
  vi.unstubAllGlobals();
});
