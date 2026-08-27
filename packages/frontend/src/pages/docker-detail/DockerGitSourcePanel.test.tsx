import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { renderWithRouter } from "@/test/render";
import type { DockerSourceBinding } from "@/types";
import { DockerGitSourcePanel } from "./DockerGitSourcePanel";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));

const source: DockerSourceBinding = {
  id: "11111111-1111-4111-8111-111111111111",
  target: { kind: "container", nodeId: "node-1", containerName: "api" },
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
  buildSecretNames: ["NPM_TOKEN"],
  policy: { vulnerabilityThreshold: "high" },
  desiredCommitSha: "a".repeat(40),
  deployedCommitSha: null,
  lastResolvedAt: null,
  lastPollAt: null,
  lastPollError: null,
  webhookConfiguredAt: null,
  lastWebhookAt: null,
  lastWebhookError: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const pagesSource: DockerSourceBinding = {
  ...source,
  target: { kind: "pages_project", pageProjectId: "page-project-1" },
  repositoryFullPath: "platform/site",
  applicationRoot: "apps/site",
  packageManager: "pnpm",
  packageManagerVersion: "10.15.0",
  nodeVersion: "24",
  buildScript: "build",
  artifactDirectory: "dist",
  publishTag: "production",
  buildArgs: { VITE_API_URL: "https://api.example.com" },
  policy: { vulnerabilityThreshold: "none" },
};

describe("DockerGitSourcePanel Build Secrets", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders a source that arrives after the initial loading state", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <DockerGitSourcePanel source={null} loading={false} />
      </MemoryRouter>
    );
    expect(screen.getByText(/No repository connected/)).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <DockerGitSourcePanel source={source} loading={false} />
      </MemoryRouter>
    );

    expect(await screen.findByText("platform/api")).toBeInTheDocument();
    expect(screen.queryByText(/No repository connected/)).not.toBeInTheDocument();
  });

  it("uses the clickable settings-row pattern for replacing a secret", async () => {
    const user = userEvent.setup();
    renderWithRouter(<DockerGitSourcePanel source={source} />);

    const add = screen.getByRole("button", { name: "Add secret" });
    expect(add).toHaveClass("bg-primary");
    expect(screen.queryByText("Protected")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace NPM_TOKEN" })).toHaveClass(
      "hover:bg-accent"
    );

    const row = screen.getByText("NPM_TOKEN").closest('[role="button"]');
    expect(row).toHaveClass("cursor-pointer", "hover:bg-accent/50");
    await user.click(row!);
    expect(
      await screen.findByRole("heading", { name: "Replace Build Secret" })
    ).toBeInTheDocument();
  });

  it("requires destructive confirmation before deleting a Build Secret", async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(false);
    const remove = vi.spyOn(api, "deleteDockerBuildSecret").mockResolvedValue(undefined);
    renderWithRouter(<DockerGitSourcePanel source={source} />);

    await user.click(screen.getByRole("button", { name: "Delete NPM_TOKEN" }));

    expect(confirm).toHaveBeenCalledWith({
      title: "Delete Build Secret",
      description:
        "Delete NPM_TOKEN? Builds that mount this secret will fail until it is added again.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("renders Pages build settings on the existing source panel", async () => {
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    renderWithRouter(
      <DockerGitSourcePanel
        target={{ kind: "pages_project", pageProjectId: "page-project-1" }}
        source={pagesSource}
      />
    );

    expect(screen.getByText("Application root")).toBeInTheDocument();
    expect(screen.getByDisplayValue("apps/site")).toBeInTheDocument();
    expect(screen.getByText("Build Variables")).toBeInTheDocument();
    expect(screen.getByText("VITE_API_URL")).toBeInTheDocument();
    expect(screen.getByText(/VITE_\* values are embedded/)).toBeInTheDocument();
    expect(screen.queryByText("Dockerfile")).not.toBeInTheDocument();
  });

  it("opens the node setup modal when no Build Worker is available", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    vi.spyOn(api, "createDockerSourceBuild").mockRejectedValue(
      new ApiRequestError("No online Build Worker supports the required dedicated build runtime", {
        status: 503,
        code: "NO_BUILD_WORKER_AVAILABLE",
      })
    );
    renderWithRouter(
      <DockerGitSourcePanel
        target={{ kind: "pages_project", pageProjectId: "page-project-1" }}
        source={pagesSource}
      />
    );

    await user.click(screen.getByRole("button", { name: "Build now" }));

    expect(
      await screen.findByRole("heading", { name: "Connect a Build Worker first" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Nodes/ })).toBeInTheDocument();
  });
});
