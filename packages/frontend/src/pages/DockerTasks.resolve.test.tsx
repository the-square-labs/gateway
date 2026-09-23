import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { DockerMigration } from "@/types";
import { DockerTasks } from "./DockerTasks";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 49 })),
    getTotalSize: () => count * 49,
    measure: vi.fn(),
    measureElement: vi.fn(),
  }),
}));
vi.mock("@/components/common/ConfirmDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/common/ConfirmDialog")>()),
  confirm: vi.fn().mockResolvedValue(true),
}));

class TestIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

const needsAttention: DockerMigration = {
  id: "migration-1",
  sourceNodeId: "node-1",
  targetNodeId: "node-2",
  resourceType: "container",
  resourceName: "worker",
  containerName: "worker",
  keepSource: false,
  sourceState: "running",
  status: "needs_attention",
  phase: "rollback",
  progress: {},
  errorMessage: "Migration rollback could not confirm the target was removed",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function setScopes(scopes: string[]) {
  useAuthStore.setState({
    user: { id: "user-1", scopes } as never,
    isAuthenticated: true,
    isLoading: false,
  });
}

describe("DockerTasks migration resolve", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.mocked(confirm).mockReset().mockResolvedValue(true);
    useDockerStore.setState({
      tasks: [],
      selectedNodeId: null,
      fetchTasks: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.spyOn(api, "listNodes").mockResolvedValue({ data: [], total: 0 } as never);
  });

  afterEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves a migration that needs attention from the task details", async () => {
    setScopes(["docker:tasks:manage"]);
    vi.spyOn(api, "listDockerMigrations")
      .mockResolvedValueOnce([needsAttention])
      .mockResolvedValue([{ ...needsAttention, status: "failed" }]);
    const resolve = vi
      .spyOn(api, "resolveDockerMigration")
      .mockResolvedValue({ ...needsAttention, status: "failed" });

    render(<DockerTasks embedded />);
    fireEvent.click(await screen.findByText("worker"));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    await waitFor(() => expect(resolve).toHaveBeenCalledWith("migration-1", "source"));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Resolve migration",
        confirmLabel: "Source is authoritative",
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument()
    );
  });

  it("uses the target as authoritative after cutover and respects a cancelled confirmation", async () => {
    setScopes(["docker:tasks:manage"]);
    vi.spyOn(api, "listDockerMigrations").mockResolvedValue([
      { ...needsAttention, cutoverAt: new Date().toISOString() },
    ]);
    const resolve = vi.spyOn(api, "resolveDockerMigration");
    vi.mocked(confirm).mockResolvedValueOnce(false);

    render(<DockerTasks embedded />);
    fireEvent.click(await screen.findByText("worker"));
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ confirmLabel: "Target is authoritative" })
      )
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("hides Resolve from users who cannot manage the task", async () => {
    setScopes(["docker:tasks:view"]);
    vi.spyOn(api, "listDockerMigrations").mockResolvedValue([needsAttention]);

    render(<DockerTasks embedded />);
    fireEvent.click(await screen.findByText("worker"));

    expect(await screen.findByText("Task Details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });
});
