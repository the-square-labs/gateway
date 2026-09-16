import { act, render, screen, waitFor } from "@testing-library/react";
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
