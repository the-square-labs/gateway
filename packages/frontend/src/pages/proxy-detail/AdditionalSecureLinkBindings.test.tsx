import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { ProxyAdditionalSecureLink } from "@/types";
import { AdditionalSecureLinkBindings } from "./AdditionalSecureLinkBindings";

const realtime = vi.hoisted(
  () => new Map<string, { handler: (event: unknown) => unknown; onReconnect?: () => unknown }>()
);
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (
    channel: string,
    handler: (event: unknown) => unknown,
    options?: { onReconnect?: () => unknown }
  ) => {
    realtime.set(channel, { handler, onReconnect: options?.onReconnect });
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  realtime.clear();
});

const binding = {
  id: "binding-1",
  proxyHostId: "host-1",
  name: "route-api",
  purpose: "additional_route",
  managedRoutePath: "/api",
  targetContainer: "api",
  dockerContainerPort: 3000,
  forwardScheme: "http",
  status: "active",
} as ProxyAdditionalSecureLink;

it("refreshes bindings after route creation, modification and deletion without reloading the page", async () => {
  const list = vi.spyOn(api, "listProxyAdditionalSecureLinks").mockResolvedValue([]);
  vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
  render(<AdditionalSecureLinkBindings hostId="host-1" canManage={false} />);
  await screen.findByText(/No additional bindings/);
  list.mockResolvedValue([binding]);
  await act(async () => {
    await realtime
      .get("proxy.additional-route.changed")!
      .handler({ id: "host-1", action: "created" });
  });
  expect(screen.getByText("/api")).toBeInTheDocument();
  list.mockResolvedValue([{ ...binding, managedRoutePath: "/v2", status: "failed" }]);
  await act(async () => {
    await realtime
      .get("proxy.additional-route.changed")!
      .handler({ id: "host-1", action: "updated" });
  });
  expect(screen.getByText("/v2")).toBeInTheDocument();
  expect(screen.queryByText("/api")).not.toBeInTheDocument();
  list.mockResolvedValue([]);
  await act(async () => {
    await realtime
      .get("proxy.additional-route.changed")!
      .handler({ id: "host-1", action: "deleted" });
  });
  expect(screen.getByText(/No additional bindings/)).toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(4);
  await act(async () => {
    await realtime
      .get("proxy.additional-route.changed")!
      .handler({ id: "other-host", action: "created" });
  });
  expect(list).toHaveBeenCalledTimes(4);
});

it("does not let a stale load erase a binding found after reconnect", async () => {
  let resolveOld!: (items: ProxyAdditionalSecureLink[]) => void;
  vi.spyOn(api, "listProxyAdditionalSecureLinks")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue([binding]);
  vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
  render(<AdditionalSecureLinkBindings hostId="host-1" canManage={false} />);
  await waitFor(() => expect(resolveOld).toBeDefined());
  await act(async () => {
    await realtime.get("proxy.additional-route.changed")!.onReconnect?.();
  });
  expect(screen.getByText("/api")).toBeInTheDocument();
  await act(async () => resolveOld([]));
  expect(screen.getByText("/api")).toBeInTheDocument();
});
