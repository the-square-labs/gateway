import { fireEvent, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DockerBuild } from "@/types";
import { DockerBuildHistoryPanel } from "./DockerBuildHistoryPanel";

describe("DockerBuildHistoryPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows 5 recent builds and opens the full history from View all", async () => {
    const builds = Array.from({ length: 12 }, (_, index) => build(index));
    vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({ data: builds, nextCursor: null });
    vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);
    renderWithRouter(
      <DockerBuildHistoryPanel
        builds={builds}
        sourceBindingId="11111111-1111-4111-8111-111111111111"
      />
    );

    expect(screen.getAllByRole("row")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "View all" }));

    const dialog = await screen.findByRole("dialog", { name: "Build history" });
    expect(dialog).toBeInTheDocument();
    const scrollContainer = dialog.querySelector('[data-route-scroll-container=""]');
    expect(scrollContainer).toHaveClass("overflow-y-auto");
    expect(scrollContainer).not.toHaveClass("overflow-auto");
    expect(api.listDockerBuildPage).toHaveBeenCalledWith({
      sourceBindingId: "11111111-1111-4111-8111-111111111111",
      cursor: undefined,
      limit: 50,
    });
    expect(screen.queryByText("End of build history")).not.toBeInTheDocument();
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
