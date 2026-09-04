import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
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
});
