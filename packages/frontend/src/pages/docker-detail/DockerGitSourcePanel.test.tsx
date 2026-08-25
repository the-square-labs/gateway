import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
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

describe("DockerGitSourcePanel Build Secrets", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders a source that arrives after the initial loading state", async () => {
    const { rerender } = renderWithRouter(<DockerGitSourcePanel source={null} loading={false} />);
    expect(screen.getByText(/No repository connected/)).toBeInTheDocument();

    rerender(<DockerGitSourcePanel source={source} loading={false} />);

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
});
