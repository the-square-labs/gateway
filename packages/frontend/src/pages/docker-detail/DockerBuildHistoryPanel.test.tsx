import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DockerBuild } from "@/types";
import { DockerBuildHistoryPanel } from "./DockerBuildHistoryPanel";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@/components/ui/data-table", async () => {
  const { useContentLoading } = await import("@/components/common/reveal-gate");
  return {
    DataTable: ({
      className,
      columns,
      data,
      footer,
      keyFn,
      loading,
      onRowClick,
      scrollRef,
    }: {
      className?: string;
      columns: Array<{
        key: string;
        header: string;
        align?: "left" | "center" | "right";
        render?: (row: unknown) => ReactNode;
      }>;
      data: unknown[];
      footer?: ReactNode;
      keyFn: (row: unknown) => string;
      loading?: boolean;
      onRowClick?: (row: unknown) => void;
      scrollRef?: Ref<HTMLDivElement>;
    }) => {
      // Like the real table, an empty first load is reported to the enclosing gate.
      useContentLoading(Boolean(loading) && data.length === 0);
      return (
        <div className={className}>
          <div>
            {columns.map((column) => (
              <span key={column.key} data-column={column.key} data-align={column.align ?? "left"}>
                {column.header}
              </span>
            ))}
          </div>
          <div ref={scrollRef} data-route-scroll-container="" className="overflow-y-auto">
            {data.map((row) => (
              <div key={keyFn(row)} role="row" onClick={() => onRowClick?.(row)}>
                {columns.map((column) => (
                  <div key={column.key}>{column.render?.(row)}</div>
                ))}
              </div>
            ))}
            {footer}
          </div>
        </div>
      );
    },
  };
});

describe("DockerBuildHistoryPanel", () => {
  beforeEach(() => {
    vi.mocked(useRealtime).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ticks the history every second without refetching and freezes completed rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:10Z"));
    const active = {
      ...build(0),
      status: "building" as const,
      startedAt: "2026-09-10T12:00:00Z",
      completedAt: null,
      progress: { elapsedSeconds: 1 },
    };
    const completed = {
      ...build(1),
      startedAt: "2026-09-10T12:00:00Z",
      completedAt: "2026-09-10T12:00:04Z",
    };
    const request = vi
      .spyOn(api, "listDockerBuildPage")
      .mockResolvedValue({ data: [active, completed], nextCursor: null });
    renderWithRouter(<DockerBuildHistoryPanel sourceBindingId="source-1" />);
    await act(async () => undefined);
    expect(screen.getByText("10s")).toBeInTheDocument();
    expect(screen.getByText("4s")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText("11s")).toBeInTheDocument();
    expect(screen.getByText("4s")).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shows a failed build reason in details and keeps metadata rows vertically centered", async () => {
    const failedBuild: DockerBuild = {
      ...build(0),
      status: "failed",
      errorCode: "BUILD_DISPATCH_FAILED",
      errorMessage: "relay grant revision 3 is older than 177",
    };
    vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({
      data: [failedBuild],
      nextCursor: null,
    });
    vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);
    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );

    // A finished build without an artifact says so instead of waiting for one.
    expect(await screen.findByText("No artifact")).toBeInTheDocument();
    fireEvent.click(screen.getByText(failedBuild.commitSha.slice(0, 8)));

    // The table row shows the reason too; the details dialog repeats it.
    const details = within(await screen.findByRole("dialog"));
    expect(await details.findByText(failedBuild.errorMessage!)).toBeInTheDocument();
    const buildWorkerLabel = details
      .getAllByText("Build Worker")
      .find((element) => element.tagName === "SPAN");
    const statusLabel = details
      .getAllByText("Status")
      .find((element) => element.tagName === "SPAN");
    expect(buildWorkerLabel?.parentElement).toHaveClass("items-center");
    expect(statusLabel?.parentElement).toHaveClass("items-center");
  });

  it("loads the history in the shared build table and requests older rows on scroll", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
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
    vi.spyOn(api, "listDockerBuildPage").mockImplementation(async (options) =>
      options?.cursor
        ? { data: [build(51)], nextCursor: null }
        : { data: Array.from({ length: 50 }, (_, index) => build(index)), nextCursor: "older" }
    );

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );

    await waitFor(() =>
      expect(api.listDockerBuildPage).toHaveBeenCalledWith({
        sourceBindingId: "11111111-1111-4111-8111-111111111111",
        cursor: undefined,
        limit: 50,
      })
    );
    expect(await screen.findByText("Scroll to load older builds")).toBeInTheDocument();
    const scrollContainer = document.querySelector('[data-route-scroll-container=""]');
    expect(scrollContainer).toHaveClass("overflow-y-auto");
    expect(scrollContainer?.parentElement).toHaveClass("[&_[data-route-scroll-container]]:flex-1");
    // The Docker Builds page table without the Source / resource column, which would repeat
    // this one resource; the commit leads.
    expect(screen.queryByText("Source / resource")).not.toBeInTheDocument();
    expect(screen.queryByText("Service")).not.toBeInTheDocument();
    expect(screen.getByText("Commit / ref")).toHaveAttribute("data-align", "left");
    expect(screen.getByText("Status")).toHaveAttribute("data-align", "right");
    expect(screen.getByText("Result")).toHaveAttribute("data-align", "right");
    expect(screen.getByText("Duration / created")).toHaveAttribute("data-align", "right");
    expect(screen.queryByText("Build Worker")).not.toBeInTheDocument();
    expect(screen.getAllByText("10s").length).toBeGreaterThan(0);

    await waitFor(() => expect(intersectionCallback).toBeDefined());
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    await waitFor(() =>
      expect(api.listDockerBuildPage).toHaveBeenCalledWith({
        sourceBindingId: "11111111-1111-4111-8111-111111111111",
        cursor: "older",
        limit: 50,
      })
    );
  });

  it("leads Compose build history with the service instead of the resource", async () => {
    const serviceBuild = (index: number, serviceName: string): DockerBuild => ({
      ...build(index),
      serviceName,
      target: {
        kind: "compose_project",
        nodeId: "33333333-3333-4333-8333-333333333333",
        composeProjectId: "44444444-4444-4444-8444-444444444444",
        name: "stack",
        serviceName,
      },
    });
    vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({
      data: [serviceBuild(0, "api"), serviceBuild(1, "worker")],
      nextCursor: null,
    });

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );

    expect(await screen.findByText("worker")).toBeInTheDocument();
    expect(screen.getByText("Service")).toHaveAttribute("data-align", "left");
    expect(screen.getByText("Commit / ref")).toHaveAttribute("data-align", "right");
    expect(screen.queryByText("Source / resource")).not.toBeInTheDocument();
  });

  it("does not let an older initial page overwrite a newer realtime refresh", async () => {
    let resolveInitial!: (page: { data: DockerBuild[]; nextCursor: string | null }) => void;
    const initialPage = new Promise<{ data: DockerBuild[]; nextCursor: string | null }>(
      (resolve) => {
        resolveInitial = resolve;
      }
    );
    const stale = build(0);
    const fresh = { ...stale, status: "failed" as const, errorMessage: "builder failed" };
    vi.spyOn(api, "listDockerBuildPage")
      .mockReturnValueOnce(initialPage)
      .mockResolvedValueOnce({ data: [fresh], nextCursor: null });

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );
    await waitFor(() => expect(api.listDockerBuildPage).toHaveBeenCalledTimes(1));
    const realtimeHandler = [...vi.mocked(useRealtime).mock.calls].find(
      ([channel]) => channel === "docker.build.changed"
    )?.[1];
    expect(realtimeHandler).toBeTypeOf("function");

    act(() => {
      realtimeHandler?.({ sourceBindingId: "11111111-1111-4111-8111-111111111111" });
    });
    expect(await screen.findByText("failed")).toBeInTheDocument();

    await act(async () => {
      resolveInitial({ data: [stale], nextCursor: "older" });
      await initialPage;
    });
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument();
  });

  it("does not append an older cursor page after a realtime head refresh", async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
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
    let resolveCursor!: (page: { data: DockerBuild[]; nextCursor: string | null }) => void;
    const cursorPage = new Promise<{ data: DockerBuild[]; nextCursor: string | null }>(
      (resolve) => {
        resolveCursor = resolve;
      }
    );
    const head = Array.from({ length: 50 }, (_, index) => build(index));
    vi.spyOn(api, "listDockerBuildPage")
      .mockResolvedValueOnce({ data: head, nextCursor: "older" })
      .mockReturnValueOnce(cursorPage)
      .mockResolvedValueOnce({ data: head, nextCursor: "older" });

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );
    await screen.findByText("Scroll to load older builds");
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    await waitFor(() => expect(api.listDockerBuildPage).toHaveBeenCalledTimes(2));
    const realtimeHandler = [...vi.mocked(useRealtime).mock.calls].find(
      ([channel]) => channel === "docker.build.changed"
    )?.[1];
    act(() => {
      realtimeHandler?.({ sourceBindingId: "11111111-1111-4111-8111-111111111111" });
    });
    await waitFor(() => expect(api.listDockerBuildPage).toHaveBeenCalledTimes(3));

    await act(async () => {
      resolveCursor({ data: [build(51)], nextCursor: null });
      await cursorPage;
    });
    expect(screen.queryByText(build(51).commitSha.slice(0, 8))).not.toBeInTheDocument();
  });

  it("keeps an older active build and merges its terminal realtime update", async () => {
    const olderActive = {
      ...build(99),
      status: "building" as const,
      completedAt: null,
    };
    const terminal = {
      ...olderActive,
      status: "failed" as const,
      errorCode: "BUILD_CANCELLED",
      errorMessage: "Superseded build stopped",
      completedAt: "2026-08-24T02:35:00.000Z",
    };
    const newerHead = Array.from({ length: 50 }, (_, index) => build(index));
    vi.spyOn(api, "listDockerBuildPage")
      .mockResolvedValueOnce({ data: [olderActive], nextCursor: null })
      .mockResolvedValueOnce({ data: newerHead, nextCursor: "older" });
    vi.spyOn(api, "getDockerBuild").mockResolvedValue(terminal);

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );
    expect(await screen.findByText(olderActive.commitSha.slice(0, 8))).toBeInTheDocument();
    const realtimeHandler = [...vi.mocked(useRealtime).mock.calls].find(
      ([channel]) => channel === "docker.build.changed"
    )?.[1];

    act(() => {
      realtimeHandler?.({
        buildId: olderActive.id,
        sourceBindingId: olderActive.sourceBindingId,
      });
    });

    await waitFor(() => expect(api.getDockerBuild).toHaveBeenCalledWith(olderActive.id));
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(olderActive.commitSha.slice(0, 8))).toBeInTheDocument();
  });

  it("ignores an older point response that resolves after a newer build update", async () => {
    let resolveOlder!: (build: DockerBuild) => void;
    let resolveNewer!: (build: DockerBuild) => void;
    const olderResponse = new Promise<DockerBuild>((resolve) => {
      resolveOlder = resolve;
    });
    const newerResponse = new Promise<DockerBuild>((resolve) => {
      resolveNewer = resolve;
    });
    const active = { ...build(77), status: "building" as const, completedAt: null };
    const terminal = {
      ...active,
      status: "failed" as const,
      errorCode: "BUILD_FAILED",
      errorMessage: "Builder failed",
      completedAt: "2026-08-24T02:35:00.000Z",
    };
    vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({ data: [active], nextCursor: null });
    vi.spyOn(api, "getDockerBuild")
      .mockReturnValueOnce(olderResponse)
      .mockReturnValueOnce(newerResponse);

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );
    await screen.findByText("building");
    const realtimeHandler = [...vi.mocked(useRealtime).mock.calls].find(
      ([channel]) => channel === "docker.build.changed"
    )?.[1];

    act(() => {
      realtimeHandler?.({ buildId: active.id, sourceBindingId: active.sourceBindingId });
      realtimeHandler?.({ buildId: active.id, sourceBindingId: active.sourceBindingId });
    });
    await waitFor(() => expect(api.getDockerBuild).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer(terminal);
      await newerResponse;
    });
    expect(await screen.findByText("failed")).toBeInTheDocument();

    await act(async () => {
      resolveOlder(active);
      await olderResponse;
    });
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.queryByText("building")).not.toBeInTheDocument();
  });

  it("shows the result detail under the result badge", async () => {
    const completed = build(0);
    completed.artifact = {
      id: "artifact-1",
      buildId: completed.id,
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
    vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({ data: [completed], nextCursor: null });

    renderWithRouter(
      <DockerBuildHistoryPanel sourceBindingId="11111111-1111-4111-8111-111111111111" />
    );

    expect(await screen.findByText("Deployed")).toBeInTheDocument();
    expect(screen.getByText("Deployment completed")).toBeInTheDocument();
    expect(screen.queryByText(/sha256:/)).not.toBeInTheDocument();
  });
});

function build(index: number): DockerBuild {
  return {
    id: `build-${index}`,
    sourceBindingId: "11111111-1111-4111-8111-111111111111",
    batchId: null,
    serviceName: null,
    provider: "gitlab",
    trigger: "gitlab_push",
    repositoryFullPath: "platform/api",
    ref: "refs/heads/main",
    commitSha: `${String(index).padStart(2, "0")}${"a".repeat(38)}`,
    status: "succeeded",
    builderNodeId: "22222222-2222-4222-8222-222222222222",
    builderName: "builder-eu-1",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: { targetName: "api" },
    artifact: null,
    target: {
      kind: "container",
      nodeId: "33333333-3333-4333-8333-333333333333",
      containerName: "api",
      name: "api",
    },
    createdAt: "2026-08-24T02:31:00.000Z",
    queuedAt: "2026-08-24T02:31:00.000Z",
    startedAt: "2026-08-24T02:31:01.000Z",
    completedAt: "2026-08-24T02:31:11.000Z",
  };
}
