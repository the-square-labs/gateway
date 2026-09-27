import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import {
  DockerPendingContainerDetail,
  resolveContainerOrPendingSource,
} from "./DockerPendingContainerDetail";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("../DockerContainerDetail", () => ({
  DockerContainerDetail: ({ resolvedContainerId }: { resolvedContainerId: string }) => (
    <div>Runtime {resolvedContainerId}</div>
  ),
}));
vi.mock("./DockerResourceGitTabs", () => ({
  DockerResourceGitTabs: ({ view }: { view: string }) => <div>Existing Git {view}</div>,
}));
vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));
vi.mock("@/lib/managed-database-nodes", () => ({
  listManagedDatabaseCandidateNodes: vi.fn().mockResolvedValue([{ id: "database-node" }]),
}));
const linkSections = vi.hoisted(() => ({
  props: {} as Record<string, Record<string, unknown>>,
  applied: [] as Array<[string, unknown]>,
}));
/** Both link sections as the Environment tab uses them: staged changes, saved through the tab. */
function linkSection(kind: string) {
  return forwardRef(function LinkSection(props: Record<string, unknown>, ref) {
    linkSections.props[kind] = props;
    useImperativeHandle(ref, () => ({
      applyChanges: async (options?: unknown) => {
        linkSections.applied.push([kind, options]);
      },
    }));
    return (
      <button
        type="button"
        onClick={() => {
          (props.onDraftChange as (draft: unknown) => void)({
            hasChanges: true,
            managedVariableNames: [`${kind.toUpperCase()}_URL`],
            pendingAdditionVariableNames: [`${kind.toUpperCase()}_URL`],
            replacementVariableNames: [],
          });
        }}
      >
        Stage {kind} link
      </button>
    );
  });
}
vi.mock("./ManagedDatabaseLinksSection", () => ({
  ManagedDatabaseLinksSection: linkSection("database"),
}));
vi.mock("./ManagedStorageLinksSection", () => ({
  ManagedStorageLinksSection: linkSection("storage"),
}));

describe("pending Git container", () => {
  it("hands off to runtime detail and stops polling after the first successful deployment", async () => {
    vi.useFakeTimers();
    const inspect = vi
      .spyOn(api, "inspectContainerByName")
      .mockResolvedValue({ Id: "runtime-id", Name: "/app" });
    const rendered = renderWithRouter(
      <DockerPendingContainerDetail
        nodeId="node"
        nodeSlug="docker"
        containerName="app"
        snapshot={{
          pendingSourceBuild: true,
          scopeResourceId: "stable",
          sourceBindingId: "source",
        }}
      />
    );
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(screen.getByText("Runtime runtime-id")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(inspect).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it("requires a persisted, scoped pending identity before rendering a missing runtime", async () => {
    const missing = new Error("No such container");
    vi.spyOn(api, "inspectContainerByName").mockRejectedValue(missing);
    const pending = vi.spyOn(api, "getPendingDockerSourceContainer").mockResolvedValue({
      pendingSourceBuild: true,
      nodeId: "node",
      containerName: "app",
      sourceBindingId: "source",
      scopeResourceId: "stable",
    });
    await expect(resolveContainerOrPendingSource("node", "app")).resolves.toMatchObject({
      Id: "source",
      Name: "/app",
      pendingSourceBuild: true,
      scopeResourceId: "stable",
    });
    pending.mockRejectedValue(new Error("Forbidden"));
    await expect(resolveContainerOrPendingSource("node", "app")).rejects.toBe(missing);
    vi.restoreAllMocks();
  });
  it("keeps Source editable and runtime actions absent before first deployment", () => {
    renderWithRouter(
      <DockerPendingContainerDetail
        nodeId="node"
        nodeSlug="docker"
        containerName="pending-app"
        snapshot={{
          pendingSourceBuild: true,
          scopeResourceId: "stable",
          sourceBindingId: "source",
        }}
      />
    );
    expect(screen.getByRole("heading", { name: "pending-app" })).toBeInTheDocument();
    expect(screen.getByText("Existing Git source")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Builds" })).toBeInTheDocument();
    expect(screen.getByText(/edit the security policy in Source/)).toBeInTheDocument();
    for (const name of ["Start", "Stop", "Restart", "Migrate", "Console", "Files", "Monitoring"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name })).not.toBeInTheDocument();
    }
  });

  it("links databases and storage before the first build creates the container, without touching its environment", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "docker:containers:environment:node/stable",
          "docker:containers:secrets:node/stable",
          "storage:view",
          "storage:iam",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.mocked(confirm).mockResolvedValue(true);
    renderWithRouter(
      <DockerPendingContainerDetail
        nodeId="node"
        nodeSlug="docker"
        containerName="pending-app"
        snapshot={{
          pendingSourceBuild: true,
          scopeResourceId: "stable",
          sourceBindingId: "source",
        }}
      />
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Environment" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stage database link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stage storage link" }));

    // The reservation's container name is the link target; nothing recreates a running workload yet.
    for (const kind of ["database", "storage"]) {
      expect(linkSections.props[kind]).toMatchObject({
        nodeId: "node",
        targetType: "container",
        targetResourceId: "pending-app",
        recreatesRunningWorkload: false,
      });
    }
    // Each section keeps clear of the other's variable names.
    await waitFor(() =>
      expect(linkSections.props.database!.existingVariableNames).toEqual(["STORAGE_URL"])
    );
    expect(linkSections.props.storage!.existingVariableNames).toEqual(["DATABASE_URL"]);

    act(() => (linkSections.props.database!.onSaveRequested as () => void)());

    await waitFor(() =>
      expect(linkSections.applied).toEqual([
        ["database", undefined],
        ["storage", undefined],
      ])
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("first build creates the container"),
      })
    );
  });

  it("keeps the links out of reach without environment and secrets permissions", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:view:node/stable", "storage:view"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    renderWithRouter(
      <DockerPendingContainerDetail
        nodeId="node"
        nodeSlug="docker"
        containerName="pending-app"
        snapshot={{
          pendingSourceBuild: true,
          scopeResourceId: "stable",
          sourceBindingId: "source",
        }}
      />
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Environment" }));

    expect(
      await screen.findByText(
        "You don't have permission to access environment variables or secrets."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stage/ })).not.toBeInTheDocument();
  });
});
