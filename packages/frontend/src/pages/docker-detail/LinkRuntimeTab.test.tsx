import { act, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import type { ManagedDatabase, ManagedDatabaseBinding } from "@/types";
import { type ContainerDatabaseLink, LinkRuntimeTab } from "./LinkRuntimeTab";

const database = {
  id: "22222222-2222-4222-8222-222222222222",
  databaseConnectionId: "database-connection-1",
  slug: "orders",
  name: "Orders",
  type: "postgres",
  version: "17",
  nodeId: "database-node-1",
  storageSizeBytes: "10737418240",
  runtimeConfig: { cpuCores: 2, memoryMb: 2048, swapMb: 0 },
  publishedPort: null,
  publishedNativePort: null,
  tlsEnabled: true,
  status: "ready",
  lastError: null,
  createdAt: "2026-08-28T12:00:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
} satisfies ManagedDatabase;

const binding = {
  id: "11111111-1111-4111-8111-111111111111",
  managedDatabaseId: database.id,
  targetNodeId: "node-1",
  targetType: "container",
  targetResourceId: "cloud-chat-connector-relay",
  environment: { connectionUri: "DATABASE_URL" },
  status: "ready",
  lastError: null,
  createdAt: "2026-08-28T12:00:00.000Z",
  updatedAt: "2026-08-28T12:00:00.000Z",
} satisfies ManagedDatabaseBinding;

describe("LinkRuntimeTab", () => {
  it("renders one 4-column metric grid with all eight cards for each database link", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    vi.spyOn(api, "getManagedDatabaseBindingRuntime").mockResolvedValue({
      binding,
      runtime: {
        routeId: "route-1",
        activeStreams: 3,
        openedTotal: "12",
        completedTotal: "10",
        failedTotal: "1",
        throttledTotal: "2",
        sourceToTargetBytes: "1024",
        targetToSourceBytes: "2048",
        setupLatencyP95Ms: 12.5,
        averageDurationMs: 350,
        lastActivityAt: "2026-08-28T13:20:00.000Z",
        metricsSince: "2026-08-28T12:20:00.000Z",
      },
    });
    const links: ContainerDatabaseLink[] = [{ database, binding }];

    const { container } = render(<LinkRuntimeTab links={links} />);

    expect(await screen.findByText("Orders")).toBeInTheDocument();
    for (const label of [
      "Active streams",
      "New streams",
      "Source → target",
      "Target → source",
      "Open success",
      "Setup p95",
      "Average duration",
      "Admission rejects",
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll(".lg\\:grid-cols-4")).toHaveLength(1);
    expect(screen.queryByText("Link traffic")).not.toBeInTheDocument();
    expect(screen.queryByText("Tunnel reliability")).not.toBeInTheDocument();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  it("does not overlap runtime polling while the previous request is still pending", async () => {
    vi.useFakeTimers();
    let resolveRuntime!: (
      value: Awaited<ReturnType<typeof api.getManagedDatabaseBindingRuntime>>
    ) => void;
    const pending = new Promise<Awaited<ReturnType<typeof api.getManagedDatabaseBindingRuntime>>>(
      (resolve) => {
        resolveRuntime = resolve;
      }
    );
    const runtimeSpy = vi.spyOn(api, "getManagedDatabaseBindingRuntime").mockReturnValue(pending);

    const view = render(<LinkRuntimeTab links={[{ database, binding }]} />);
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(runtimeSpy).toHaveBeenCalledOnce();

    resolveRuntime({ binding, runtime: null });
    await act(async () => {
      await pending;
    });
    view.unmount();
    vi.useRealTimers();
  });

  it("treats telemetry transport failures as unavailable without reporting a Secure Link outage", async () => {
    vi.spyOn(api, "getManagedDatabaseBindingRuntime").mockRejectedValue(
      new Error("relay unavailable")
    );
    const onHealthChange = vi.fn();

    render(<LinkRuntimeTab links={[{ database, binding }]} onHealthChange={onHealthChange} />);

    await vi.waitFor(() => expect(onHealthChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText("relay unavailable")).not.toBeInTheDocument();
    expect(
      await screen.findByText("Runtime telemetry is temporarily unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Active streams")).not.toBeInTheDocument();
  });

  it("hides an authoritative failed binding and reports the Secure Link outage", async () => {
    const failedBinding: ContainerDatabaseLink["binding"] = {
      ...binding,
      status: "error",
      lastError: "connector unavailable",
    };
    const runtimeSpy = vi.spyOn(api, "getManagedDatabaseBindingRuntime");
    const onHealthChange = vi.fn();

    render(
      <LinkRuntimeTab
        links={[{ database, binding: failedBinding }]}
        onHealthChange={onHealthChange}
      />
    );

    await vi.waitFor(() => expect(onHealthChange).toHaveBeenCalledWith(true));
    expect(screen.queryByText("Orders")).not.toBeInTheDocument();
    expect(runtimeSpy).not.toHaveBeenCalled();
  });

  it("keeps rendered cards stable when an equivalent snapshot object arrives", async () => {
    vi.spyOn(api, "getManagedDatabaseBindingRuntime").mockResolvedValue({
      binding,
      runtime: {
        routeId: "route-1",
        activeStreams: 1,
        openedTotal: "1",
        completedTotal: "1",
        failedTotal: "0",
        throttledTotal: "0",
        sourceToTargetBytes: "0",
        targetToSourceBytes: "0",
        setupLatencyP95Ms: 1,
        averageDurationMs: 1,
        lastActivityAt: null,
        metricsSince: "2026-08-30T00:00:00.000Z",
      },
    });
    const view = render(<LinkRuntimeTab links={[{ database, binding }]} />);
    expect(await screen.findByText("Active streams")).toBeInTheDocument();

    view.rerender(
      <LinkRuntimeTab links={[{ database: { ...database }, binding: { ...binding } }]} />
    );

    expect(screen.getByText("Active streams")).toBeInTheDocument();
  });

  it("does not restart polling when the same links arrive in a different order", async () => {
    const runtimeSpy = vi.spyOn(api, "getManagedDatabaseBindingRuntime").mockResolvedValue({
      binding,
      runtime: null,
    });
    const secondLink: ContainerDatabaseLink = {
      database: { ...database, id: "33333333-3333-4333-8333-333333333333", name: "Analytics" },
      binding: {
        ...binding,
        id: "44444444-4444-4444-8444-444444444444",
        managedDatabaseId: "33333333-3333-4333-8333-333333333333",
      },
    };
    const links: ContainerDatabaseLink[] = [{ database, binding }, secondLink];
    const view = render(<LinkRuntimeTab links={links} />);

    await vi.waitFor(() => expect(runtimeSpy).toHaveBeenCalledTimes(2));
    view.rerender(<LinkRuntimeTab links={[...links].reverse()} />);
    await act(async () => undefined);

    expect(runtimeSpy).toHaveBeenCalledTimes(2);
  });
});
