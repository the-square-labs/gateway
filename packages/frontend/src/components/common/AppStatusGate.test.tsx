import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStatusStore } from "@/stores/app-status";
import {
  AppStatusGate,
  buildGatewayRestartTargetUrl,
  isGatewayUpdateTargetVersion,
  normalizeGatewayUpdateVersion,
} from "./AppStatusGate";

beforeEach(() => {
  useAppStatusStore.setState({
    maintenanceActive: false,
    gatewayUpdatingActive: false,
    gatewayUpdatingTargetVersion: null,
    gatewayRestartingActive: false,
    gatewayRestartTargetUrl: null,
    gatewayUpdateError: null,
    rateLimitedUntil: null,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ lifecycleState: "draining_user", version: "2.4.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway update version matching", () => {
  it("matches target and current versions regardless of v prefix", () => {
    expect(normalizeGatewayUpdateVersion("v2.4.0")).toBe("2.4.0");
    expect(isGatewayUpdateTargetVersion("2.4.0", "v2.4.0")).toBe(true);
    expect(isGatewayUpdateTargetVersion("v2.4.0", "2.4.0")).toBe(true);
    expect(isGatewayUpdateTargetVersion("2.4.1", "v2.4.0")).toBe(false);
  });

  it("preserves the current route when switching to a restarted listener", () => {
    expect(
      buildGatewayRestartTargetUrl(
        "https://gateway.test:3000",
        "http://gateway.test:3000/settings/general?panel=web#tls"
      )
    ).toBe("https://gateway.test:3000/settings/general?panel=web#tls");
  });

  it("shows update-specific copy when a target version is known", () => {
    useAppStatusStore.setState({
      gatewayUpdatingActive: true,
      gatewayUpdatingTargetVersion: "v2.5.0",
    });

    render(<AppStatusGate />);

    expect(screen.getByRole("heading", { name: "Updating Gateway" })).toBeInTheDocument();
    expect(
      screen.getByText("Gateway is updating to v2.5.0.", { exact: false })
    ).toBeInTheDocument();
  });

  it("shows generic restart copy when admission closes", () => {
    useAppStatusStore.setState({ gatewayRestartingActive: true });

    render(<AppStatusGate />);

    expect(screen.getByRole("heading", { name: "Restarting Gateway" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Gateway is finishing active work before restarting. New actions are temporarily locked."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Finishing active requests and jobs…")).not.toBeInTheDocument();
    expect(screen.queryByText("This page will reload automatically.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wiolett Industries" })).toHaveAttribute(
      "href",
      "https://wiolett.net"
    );
  });

  it("never overlaps restart recovery requests", async () => {
    vi.useFakeTimers();
    useAppStatusStore.setState({ gatewayRestartingActive: true });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    render(<AppStatusGate />);

    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runs unavailable recovery checks sequentially and stops after stable recovery", async () => {
    vi.useFakeTimers();
    window.sessionStorage.setItem("gateway-maintenance-auto-reload", "1");
    useAppStatusStore.setState({ maintenanceActive: true });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/health") {
        return new Response(JSON.stringify({ lifecycleState: "running", version: "2.4.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { state: "complete" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<AppStatusGate />);

    const recoveryCheckCount = () =>
      fetchMock.mock.calls.filter(([input]) => String(input) === "/api/setup/status").length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(recoveryCheckCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(recoveryCheckCount()).toBe(2);
    expect(useAppStatusStore.getState().maintenanceActive).toBe(false);
    expect(
      screen.queryByRole("heading", { name: "Temporarily Unavailable" })
    ).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(recoveryCheckCount()).toBe(2);
  });

  it("uses the restart layout for unavailable state without manual actions", async () => {
    vi.useFakeTimers();
    useAppStatusStore.setState({ maintenanceActive: true });

    render(<AppStatusGate />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(screen.getByRole("heading", { name: "Temporarily Unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload now" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Checking backend availability automatically.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wiolett Industries" })).toHaveAttribute(
      "href",
      "https://wiolett.net"
    );
  });

  it("never overlaps unavailable recovery requests", async () => {
    vi.useFakeTimers();
    useAppStatusStore.setState({ maintenanceActive: true });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    render(<AppStatusGate />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a stale regular restart blocker when Gateway is already healthy", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ lifecycleState: "running", version: "2.4.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    useAppStatusStore.setState({ gatewayRestartingActive: true });

    render(<AppStatusGate />);

    await waitFor(() => expect(useAppStatusStore.getState().gatewayRestartingActive).toBe(false));
    expect(screen.queryByRole("heading", { name: "Restarting Gateway" })).not.toBeInTheDocument();
  });

  it("clears the rate-limit blocker without reloading the page", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T16:00:00Z"));
    useAppStatusStore.setState({ rateLimitedUntil: Date.now() + 1_000 });

    render(<AppStatusGate />);

    expect(screen.getByRole("heading", { name: "Rate Limit Reached" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_250));
    expect(useAppStatusStore.getState().rateLimitedUntil).toBeNull();
    expect(screen.queryByRole("heading", { name: "Rate Limit Reached" })).not.toBeInTheDocument();
  });
});
