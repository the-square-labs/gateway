import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { DockerBuild, DockerSourceBinding } from "@/types";
import { DockerResourceGitTabs } from "./DockerResourceGitTabs";

const target = { kind: "container" as const, nodeId: "node-1", containerName: "api" };
const pagesTarget = {
  kind: "pages_project" as const,
  nodeId: "node-1",
  pageProjectId: "page-project-1",
};
const source: DockerSourceBinding = {
  id: "source-1",
  target,
  connectorId: "connector-1",
  projectId: "project-1",
  provider: "gitlab",
  repositoryRemoteId: "99",
  repositoryFullPath: "platform/api",
  repositoryCloneUrl: "https://git.example.com/platform/api.git",
  branch: "main",
  dockerfilePath: "Dockerfile",
  contextPath: ".",
  composeFilePath: null,
  composeVariables: {},
  composeSecretKeys: [],
  autoBuild: true,
  autoDeploy: true,
  buildArgs: {},
  buildSecretNames: [],
  policy: { vulnerabilityThreshold: "critical" },
  desiredCommitSha: null,
  deployedCommitSha: null,
  lastResolvedAt: null,
  lastPollAt: null,
  lastPollError: null,
  webhookConfiguredAt: null,
  lastWebhookAt: null,
  lastWebhookError: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function EquivalentTargetRerenderHarness() {
  const [, setRenderCount] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setRenderCount((count) => count + 1)}>
        Parent rerender
      </button>
      <DockerResourceGitTabs target={{ ...target }} view="source" includeBuilds />
    </>
  );
}

describe("DockerResourceGitTabs source loading", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("does not present loading as an unconnected repository", () => {
    vi.spyOn(api, "getDockerSource").mockReturnValue(new Promise(() => {}));
    renderWithRouter(<DockerResourceGitTabs target={target} view="source" />);
    expect(screen.getByText("Loading repository delivery settings…")).toBeInTheDocument();
    expect(screen.queryByText(/No repository connected/)).not.toBeInTheDocument();
  });

  it("renders a retryable request error instead of an image-mode empty state", async () => {
    const user = userEvent.setup();
    const request = vi
      .spyOn(api, "getDockerSource")
      .mockRejectedValueOnce(new Error("Repository API unavailable"))
      .mockResolvedValueOnce(null);
    renderWithRouter(<DockerResourceGitTabs target={target} view="source" />);
    expect(await screen.findByText("Repository API unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/No repository connected/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/No repository connected/)).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shows the image-mode empty state only after a successful null response", async () => {
    vi.spyOn(api, "getDockerSource").mockResolvedValue(null);
    renderWithRouter(<DockerResourceGitTabs target={target} view="source" />);
    await act(async () => undefined);
    expect(await screen.findByText(/No repository connected/)).toBeInTheDocument();
  });

  it("loads recent builds below repository settings when they share the Source view", async () => {
    vi.spyOn(api, "getDockerSource").mockResolvedValue(source);
    const listBuilds = vi.spyOn(api, "listDockerBuilds").mockResolvedValue([]);

    renderWithRouter(<DockerResourceGitTabs target={target} view="source" includeBuilds />);

    expect(await screen.findByText("Builds")).toBeInTheDocument();
    expect(listBuilds).toHaveBeenCalledWith({ sourceBindingId: "source-1", limit: 5 });
  });

  it("loads Pages build history inline without the recent-builds View all pattern", async () => {
    vi.spyOn(api, "getDockerSource").mockResolvedValue({ ...source, target: pagesTarget });
    const listRecent = vi.spyOn(api, "listDockerBuilds").mockResolvedValue([]);
    const listPage = vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({
      data: [],
      nextCursor: null,
    });

    renderWithRouter(<DockerResourceGitTabs target={pagesTarget} view="builds" />);

    await waitFor(() =>
      expect(listPage).toHaveBeenCalledWith({
        sourceBindingId: "source-1",
        cursor: undefined,
        limit: 50,
      })
    );
    expect(
      await screen.findByText("Build history, security decisions, and deployment results.")
    ).toBeInTheDocument();
    expect(listRecent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
  });

  it("keeps the Source layout mounted during a background build refresh", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((value: DockerBuild[]) => void) | undefined;
    const refresh = new Promise<DockerBuild[]>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.spyOn(api, "getDockerSource").mockResolvedValue(source);
    vi.spyOn(api, "listDockerBuilds").mockResolvedValueOnce([]).mockReturnValueOnce(refresh);
    vi.spyOn(api, "createDockerSourceBuild").mockResolvedValue({} as never);

    renderWithRouter(<DockerResourceGitTabs target={target} view="source" includeBuilds />);

    await user.click(await screen.findByRole("button", { name: "Build now" }));
    await waitFor(() => expect(api.createDockerSourceBuild).toHaveBeenCalled());
    expect(screen.getByText("platform/api")).toBeInTheDocument();
    expect(screen.queryByText("Loading repository delivery settings…")).not.toBeInTheDocument();

    resolveRefresh?.([]);
  });

  it("does not reload when the parent rerenders with an equivalent target", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(api, "getDockerSource").mockResolvedValue(source);
    vi.spyOn(api, "listDockerBuilds").mockResolvedValue([]);
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    renderWithRouter(<EquivalentTargetRerenderHarness />);

    expect(await screen.findByText("Builds")).toBeInTheDocument();
    const initialRequestCount = request.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Parent rerender" }));

    expect(request).toHaveBeenCalledTimes(initialRequestCount);
  });
});
