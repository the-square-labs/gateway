import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { BuilderJobsTab } from "./BuilderJobsTab";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

let intersectionCallback: IntersectionObserverCallback | undefined;

beforeEach(() => {
  vi.mocked(useRealtime).mockClear();
  vi.spyOn(api, "listDockerBuildPage").mockImplementation(async (options) =>
    options?.cursor
      ? { data: [build("older")], nextCursor: null }
      : { data: [build("recent")], nextCursor: "next-page" }
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

it("loads and lazily paginates virtualized jobs for one Build Worker", async () => {
  const { container } = render(<BuilderJobsTab nodeId="builder-1" />);

  await waitFor(() =>
    expect(api.listDockerBuildPage).toHaveBeenCalledWith({
      builderNodeId: "builder-1",
      cursor: undefined,
      limit: 50,
    })
  );
  expect(await screen.findByText("Build jobs")).toBeInTheDocument();
  expect(screen.getByText("Scroll to load older jobs")).toBeInTheDocument();
  expect(container.querySelector(".h-fit.w-full.max-h-full")).not.toBeNull();

  await waitFor(() => expect(intersectionCallback).toBeDefined());
  act(() => {
    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
  await waitFor(() =>
    expect(api.listDockerBuildPage).toHaveBeenCalledWith({
      builderNodeId: "builder-1",
      cursor: "next-page",
      limit: 50,
    })
  );
});

function build(id: string): DockerBuild {
  return {
    id,
    sourceBindingId: "11111111-1111-4111-8111-111111111111",
    batchId: null,
    serviceName: null,
    provider: "github",
    trigger: "github_push",
    repositoryFullPath: `wiolett/${id}`,
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    status: "succeeded",
    builderNodeId: "builder-1",
    builderName: "Builder 1",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: {},
    artifact: null,
    target: {
      kind: "pages_project",
      pageProjectId: "33333333-3333-4333-8333-333333333333",
      name: "test-pages",
    },
    createdAt: "2026-08-26T08:00:00.000Z",
    queuedAt: "2026-08-26T08:00:00.000Z",
    startedAt: "2026-08-26T08:00:01.000Z",
    completedAt: "2026-08-26T08:00:10.000Z",
  };
}
