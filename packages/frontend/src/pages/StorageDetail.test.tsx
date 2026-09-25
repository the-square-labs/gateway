import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { ObjectStorageConnection } from "@/types";
import { StorageDetail } from "./StorageDetail";

const mocks = vi.hoisted(() => ({
  realtime: null as null | ((event: unknown) => void),
  hasScope: () => true,
}));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => ({ hasScope: mocks.hasScope }) }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (_event: unknown, cb: (event: unknown) => void) => {
    mocks.realtime = cb;
  },
}));
vi.mock("./storage-detail/StorageOverviewTab", () => ({
  StorageOverviewTab: ({
    history,
    monitoringLoading,
  }: {
    history: unknown[];
    monitoringLoading: boolean;
  }) => (
    <div data-testid="monitoring">{monitoringLoading ? "loading" : JSON.stringify(history)}</div>
  ),
}));
vi.mock("./storage-detail/ObjectBrowser", () => ({
  ObjectBrowser: () => <div data-testid="objects">Objects list</div>,
}));

const storage = {
  id: "s1",
  slug: "s1",
  name: "App Storage",
  provider: "minio",
  healthStatus: "online",
  healthHistory: [],
  tags: [],
} as unknown as ObjectStorageConnection;
function stream() {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  return {
    addEventListener: vi.fn((type, cb) => listeners.set(type, cb)),
    close: vi.fn(),
    onerror: null,
    emit: (type: string, payload: unknown) =>
      listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent),
  };
}

beforeEach(() => {
  vi.spyOn(api, "getObjectStorage").mockResolvedValue(storage);
  vi.spyOn(api, "getObjectStorageHealthHistory").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("Storage detail monitoring lifecycle", () => {
  it("keeps snapshots and the existing stream when metadata refreshes", async () => {
    const events = stream();
    const createStream = vi
      .spyOn(api, "createObjectStorageMonitoringStream")
      .mockReturnValue(events as never);
    render(
      <MemoryRouter>
        <StorageDetail resolvedStorageId="s1" />
      </MemoryRouter>
    );
    await waitFor(() => expect(createStream).toHaveBeenCalledTimes(1));
    act(() =>
      events.emit("history", {
        history: [{ timestamp: "2026-09-16T00:00:00Z", metrics: { cpu_pct: 12 } }],
      })
    );
    expect(screen.getByTestId("monitoring")).toHaveTextContent('"cpu_pct":12');
    vi.mocked(api.getObjectStorage).mockResolvedValue({ ...storage, name: "Renamed" });
    act(() => mocks.realtime?.({ id: "s1", action: "updated" }));
    await screen.findByText("Renamed");
    expect(createStream).toHaveBeenCalledTimes(1);
    expect(events.close).not.toHaveBeenCalled();
    expect(screen.getByTestId("monitoring")).toHaveTextContent('"cpu_pct":12');
  });

  it("waits for history after connected and ignores events from a closed stream", async () => {
    const first = stream();
    const second = stream();
    vi.spyOn(api, "createObjectStorageMonitoringStream")
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const view = render(
      <MemoryRouter>
        <StorageDetail resolvedStorageId="s1" />
      </MemoryRouter>
    );
    await waitFor(() => expect(first.addEventListener).toHaveBeenCalled());
    act(() => first.emit("connected", { healthStatus: "online" }));
    expect(screen.getByTestId("monitoring")).toHaveTextContent("loading");
    vi.mocked(api.getObjectStorage).mockResolvedValue({ ...storage, id: "s2", name: "Second" });
    view.rerender(
      <MemoryRouter>
        <StorageDetail resolvedStorageId="s2" />
      </MemoryRouter>
    );
    await waitFor(() => expect(second.addEventListener).toHaveBeenCalled());
    act(() => {
      second.emit("history", { history: [] });
      first.emit("snapshot", { status: "offline", metrics: { cpu_pct: 99 } });
    });
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("monitoring")).toHaveTextContent("[]");
  });

  it("shows the legacy MinIO banner for managed MinIO clusters only", async () => {
    vi.spyOn(api, "createObjectStorageMonitoringStream").mockReturnValue(stream() as never);
    const managed = {
      id: "cluster-1",
      nodeId: "node-1",
      version: "2025-04-22",
      storageSizeBytes: 1024,
      runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
      publishedPort: 9000,
      status: "ready",
      lastError: null,
    } as const;
    vi.mocked(api.getObjectStorage).mockResolvedValue({ ...storage, managed });
    const view = render(
      <MemoryRouter>
        <StorageDetail resolvedStorageId="s1" />
      </MemoryRouter>
    );
    const banner = await screen.findByRole("note");
    expect(banner).toHaveTextContent("MinIO is no longer distributed by its vendor");
    expect(within(banner).getByRole("link", { name: "See the migration guide" })).toHaveAttribute(
      "href",
      "https://docs.goodgateway.dev/en/storage/overview/#migrating-from-minio"
    );
    view.unmount();

    vi.mocked(api.getObjectStorage).mockResolvedValue({
      ...storage,
      provider: "seaweedfs",
      managed: { ...managed, engine: "seaweedfs", version: "4.47" },
    });
    render(
      <MemoryRouter>
        <StorageDetail resolvedStorageId="s1" />
      </MemoryRouter>
    );
    await screen.findByText("App Storage");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("lets Objects grow inside the page scroll container", async () => {
    vi.spyOn(api, "createObjectStorageMonitoringStream").mockReturnValue(stream() as never);
    render(
      <MemoryRouter initialEntries={["/storage/s1/browser"]}>
        <Routes>
          <Route path="/storage/:id/:tab" element={<StorageDetail />} />
        </Routes>
      </MemoryRouter>
    );
    const header = await screen.findByText("App Storage");
    const page = header.closest(".overflow-y-auto");
    expect(page).toHaveClass("h-full");
    expect(page).not.toHaveClass("overflow-hidden");
    expect(await screen.findByTestId("objects")).toBeInTheDocument();
  });
});
