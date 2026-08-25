import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DockerBuild } from "@/types";
import { DockerBuilds } from "./DockerBuilds";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

let intersectionCallback: IntersectionObserverCallback | undefined;

describe("DockerBuilds", () => {
  beforeEach(() => {
    vi.mocked(useRealtime).mockClear();
    vi.spyOn(api, "listDockerBuildPage").mockImplementation(async (options) =>
      options?.cursor
        ? { data: [build("older")], nextCursor: null }
        : {
            data: Array.from({ length: 10 }, (_, index) => build(`recent-${index}`)),
            nextCursor: "next-build-page",
          }
    );
    vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads build history directly in the tab and requests older rows on scroll", async () => {
    renderWithRouter(<DockerBuilds />);

    await waitFor(() =>
      expect(api.listDockerBuildPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }))
    );
    expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
    expect(await screen.findByText("Scroll to load older builds")).toBeInTheDocument();

    await waitFor(() => expect(intersectionCallback).toBeDefined());
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    await waitFor(() =>
      expect(api.listDockerBuildPage).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: "next-build-page", limit: 50 })
      )
    );
  });

  it("renders the artifact digest in its own SHA column", async () => {
    const row = build("artifact-sha");
    row.artifact = {
      id: "artifact-1",
      buildId: row.id,
      registryRepository: "gateway/builds/source-1",
      digest: `sha256:${"b".repeat(64)}`,
      platform: "linux/amd64",
      sizeBytes: 1024,
      status: "ready",
      sbomDigest: null,
      provenanceDigest: null,
      scanSummary: null,
      policyDecision: "approved",
      policyReason: null,
      verifiedAt: "2026-08-25T14:00:00.000Z",
      createdAt: "2026-08-25T14:00:00.000Z",
    };
    vi.mocked(api.listDockerBuildPage).mockResolvedValueOnce({ data: [row], nextCursor: null });

    renderWithRouter(<DockerBuilds />);

    expect(await screen.findByText("SHA")).toBeInTheDocument();
  });

  it("opens build details from a pinned build link", async () => {
    const pinned = build("pinned-build");
    vi.spyOn(api, "getDockerBuild").mockResolvedValue(pinned);

    renderWithRouter(<DockerBuilds />, { route: "/docker/builds?build=pinned-build" });

    await waitFor(() => expect(api.getDockerBuild).toHaveBeenCalledWith("pinned-build"));
    expect(await screen.findByRole("heading", { name: "Build details" })).toBeInTheDocument();
    expect(screen.getByText(pinned.repositoryFullPath)).toBeInTheDocument();
  });

  it("polls active builds every 5 seconds", async () => {
    vi.useFakeTimers();
    const active = build("active");
    active.status = "queued";
    active.completedAt = null;
    const request = vi.mocked(api.listDockerBuildPage).mockResolvedValue({
      data: [active],
      nextCursor: null,
    });

    renderWithRouter(<DockerBuilds />);
    await act(async () => undefined);
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("polls terminal build history every 15 seconds", async () => {
    vi.useFakeTimers();
    const request = vi.mocked(api.listDockerBuildPage).mockResolvedValue({
      data: [build("terminal")],
      nextCursor: null,
    });

    renderWithRouter(<DockerBuilds />);
    await act(async () => undefined);
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes the table on build events and realtime reconnect", async () => {
    const request = vi.mocked(api.listDockerBuildPage);
    renderWithRouter(<DockerBuilds />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const registration = [...vi.mocked(useRealtime).mock.calls]
      .reverse()
      .find(([channel]) => channel === "docker.build.changed");
    expect(registration).toBeDefined();
    const handler = registration?.[1] as () => void;
    const options = registration?.[2] as { onReconnect?: () => void };

    await act(async () => handler());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => options.onReconnect?.());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });
});

function build(id: string): DockerBuild {
  return {
    id,
    sourceBindingId: "11111111-1111-4111-8111-111111111111",
    batchId: null,
    serviceName: null,
    provider: "gitlab",
    trigger: "gitlab_push",
    repositoryFullPath: `platform/${id}`,
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    status: "succeeded",
    builderNodeId: "22222222-2222-4222-8222-222222222222",
    builderName: "builder-eu-1",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: { elapsedSeconds: 10, targetName: id },
    artifact: null,
    target: {
      kind: "container",
      nodeId: "33333333-3333-4333-8333-333333333333",
      containerName: id,
      name: id,
    },
    createdAt: "2026-08-24T02:31:00.000Z",
    queuedAt: "2026-08-24T02:31:00.000Z",
    startedAt: "2026-08-24T02:31:01.000Z",
    completedAt: "2026-08-24T02:31:11.000Z",
  };
}
