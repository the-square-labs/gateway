import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route } from "react-router-dom";
import { vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { renderWithRouter } from "@/test/render";
import type { DockerSourceBinding } from "@/types";
import { DockerGitSourcePanel } from "./DockerGitSourcePanel";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));
vi.mock("../docker-deploy/useDockerSourceRepositories", () => ({
  useDockerSourceRepositories: () => ({
    connectorOptions: [{ value: "connector-1", label: "Test GitLab" }],
    repositories: [{ projectId: "project-1", fullPath: "platform/api", defaultBranch: "main" }],
  }),
}));

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

  it("defaults to all packages and saves application scope without disabling the severity threshold", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    const save = vi.spyOn(api, "upsertDockerSource").mockResolvedValue({
      ...source,
      policy: { vulnerabilityThreshold: "high", vulnerabilityScope: "application" },
    });
    renderWithRouter(<DockerGitSourcePanel target={source.target} source={source} />);
    expect(screen.getByRole("combobox", { name: "Vulnerability scope" })).toHaveTextContent(
      "All packages"
    );
    await user.click(screen.getByRole("combobox", { name: "Vulnerability scope" }));
    await user.click(screen.getByRole("option", { name: /Application dependencies/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        source.target,
        expect.objectContaining({
          policy: { vulnerabilityThreshold: "high", vulnerabilityScope: "application" },
        })
      )
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });

  it("keeps the saved scope visible but read-only without edit access", () => {
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    renderWithRouter(
      <DockerGitSourcePanel
        target={source.target}
        source={{
          ...source,
          policy: { ...source.policy, vulnerabilityScope: "application" },
        }}
        canEdit={false}
      />
    );
    expect(screen.getByRole("combobox", { name: "Vulnerability scope" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Vulnerability scope" })).toHaveTextContent(
      "Application dependencies"
    );
  });

  it("warns that disconnecting removes a pending container and leaves its deleted detail page", async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    const remove = vi.spyOn(api, "removeDockerSource").mockResolvedValue(undefined);
    renderWithRouter(
      <DockerGitSourcePanel target={source.target} source={source} pendingContainer />,
      {
        path: "/pending",
        route: "/pending",
        extraRoutes: <Route path="/docker/containers" element={<div>Container list</div>} />,
      }
    );

    await user.click(screen.getByRole("button", { name: "Disconnect repository" }));

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("removes the pending container"),
      })
    );
    expect(remove).toHaveBeenCalledWith(source.target);
    expect(await screen.findByText("Container list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect repository" })).not.toBeInTheDocument();
  });

  it.each(["cancel", "failure"])("keeps the pending source after disconnect %s", async (result) => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(result !== "cancel");
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    const remove = vi
      .spyOn(api, "removeDockerSource")
      .mockRejectedValue(new Error("Webhook cleanup failed"));
    renderWithRouter(
      <DockerGitSourcePanel target={source.target} source={source} pendingContainer />
    );

    await user.click(screen.getByRole("button", { name: "Disconnect repository" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Disconnect repository" })).toBeEnabled()
    );
    expect(screen.getByText("platform/api")).toBeInTheDocument();
    if (result === "cancel") expect(remove).not.toHaveBeenCalled();
    else expect(remove).toHaveBeenCalledWith(source.target);
  });

  it("allows an existing runtime to reconnect after disconnecting its repository", async () => {
    const user = userEvent.setup();
    vi.mocked(confirm).mockResolvedValue(true);
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    vi.spyOn(api, "removeDockerSource").mockResolvedValue(undefined);
    renderWithRouter(<DockerGitSourcePanel target={source.target} source={source} />);

    await user.click(screen.getByRole("button", { name: "Disconnect repository" }));

    expect(await screen.findByRole("button", { name: "Connect repository" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("Existing runtime state") })
    );
  });

  it("keeps connection errors inside the dialog and retries with the entered Dockerfile", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listDockerBuildSecrets").mockResolvedValue([]);
    const connect = vi
      .spyOn(api, "upsertDockerSource")
      .mockRejectedValueOnce(new Error("Repository access denied"))
      .mockResolvedValue({ ...source, dockerfilePath: "apps/api/Dockerfile" });
    renderWithRouter(<DockerGitSourcePanel target={source.target} source={null} loading={false} />);
    await user.click(screen.getByRole("button", { name: "Connect repository" }));
    await user.click(screen.getByPlaceholderText("Select Git integration"));
    await user.click(await screen.findByRole("button", { name: "Test GitLab" }));
    await user.click(screen.getByPlaceholderText("Select allowlisted repository"));
    await user.click(await screen.findByRole("button", { name: "platform/api" }));
    const dockerfile = screen.getByDisplayValue("Dockerfile");
    await user.clear(dockerfile);
    await user.type(dockerfile, "apps/api/Dockerfile");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Repository access denied");
    expect(screen.getByDisplayValue("apps/api/Dockerfile")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(connect).toHaveBeenLastCalledWith(
      source.target,
      expect.objectContaining({
        dockerfilePath: "apps/api/Dockerfile",
        contextPath: ".",
      })
    );
  });
});
