import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { isDockerMigrationOwnedByTab } from "@/lib/docker-migration-navigation";
import { api } from "@/services/api";
import type { DockerMigration, DockerMigrationPreflight, Node } from "@/types";
import { DockerMigrationDialog } from "./DockerMigrationDialog";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@/components/common/ConfirmDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/common/ConfirmDialog")>()),
  confirm: vi.fn().mockResolvedValue(true),
}));

const targetNode = {
  id: "node-2",
  slug: "target",
  type: "docker",
  hostname: "target.local",
  displayName: "Target",
  appearanceColor: null,
  status: "online",
  serviceCreationLocked: false,
  daemonVersion: "1.0.0",
  osInfo: "linux",
  configVersionHash: null,
  capabilities: {},
  lastSeenAt: new Date().toISOString(),
  metadata: {},
  isConnected: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies Node;

const preflight: DockerMigrationPreflight = {
  fingerprint: "fingerprint-1",
  sourceState: "stopped",
  blockers: [],
  warnings: [],
  artifacts: [{ kind: "volume", sourceIdentity: "data", targetIdentity: "data", sizeBytes: 1024 }],
  deletionPlan: [
    { type: "container", name: "worker" },
    { type: "volume", name: "data", sizeBytes: 1024 },
  ],
};

const runningMigration: DockerMigration = {
  id: "migration-1",
  sourceNodeId: "node-1",
  targetNodeId: "node-2",
  resourceType: "container",
  resourceName: "worker",
  containerName: "worker",
  keepSource: false,
  sourceState: "stopped",
  status: "running",
  phase: "transferring_artifacts",
  progress: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("DockerMigrationDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    vi.spyOn(api, "listNodes").mockResolvedValue({ data: [targetNode], total: 1 } as never);
    vi.spyOn(api, "preflightDockerMigration").mockResolvedValue(preflight);
    vi.spyOn(api, "startDockerMigration").mockResolvedValue(runningMigration);
  });

  it("defaults to full migration and keeps a stopped source stopped", async () => {
    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        resource={{
          type: "container",
          nodeId: "node-1",
          containerName: "worker",
          displayName: "worker",
          sourceState: "stopped",
        }}
      />
    );

    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Target" }));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));

    expect(await screen.findByRole("heading", { name: "Migration preflight" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Target node")).not.toBeInTheDocument();
    expect(screen.getByText("Removed from source after verification")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start migration" }));

    await waitFor(() => {
      expect(api.startDockerMigration).toHaveBeenCalledWith(
        expect.objectContaining({
          targetNodeId: "node-2",
          keepSource: false,
          preflightFingerprint: "fingerprint-1",
        })
      );
    });
    expect(vi.mocked(api.startDockerMigration).mock.calls[0]?.[0]).not.toHaveProperty(
      "typedConfirmation"
    );
    expect(await screen.findByText(/target will remain stopped/i)).toBeInTheDocument();
    expect(isDockerMigrationOwnedByTab("migration-1")).toBe(true);
  });

  it("shows blocked preflight in the review dialog and keeps start disabled", async () => {
    vi.spyOn(api, "preflightDockerMigration").mockResolvedValue({
      ...preflight,
      blockers: [{ code: "TARGET_COLLISION", message: "Container name already exists" }],
    });

    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        resource={{
          type: "container",
          nodeId: "node-1",
          containerName: "worker",
          displayName: "worker",
          sourceState: "running",
        }}
      />
    );

    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Target" }));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));

    const blocker = await screen.findByText("Container name already exists");
    expect(screen.getByRole("heading", { name: "Verification" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blockers" })).not.toBeInTheDocument();
    expect(blocker.closest("li")).toHaveStyle({ borderColor: "var(--color-destructive)" });
    expect(screen.getByRole("button", { name: "Start migration" })).toBeDisabled();
    expect(api.startDockerMigration).not.toHaveBeenCalled();
  });

  it("reports cutover to the owning detail page", async () => {
    const onCutover = vi.fn();
    vi.spyOn(api, "startDockerMigration").mockResolvedValue({
      ...runningMigration,
      status: "cleanup_pending",
      phase: "cleanup_source",
      targetNodeSlug: "target",
      targetResourceId: "target-container-id",
      cutoverAt: new Date().toISOString(),
    });

    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        onCutover={onCutover}
        resource={{
          type: "container",
          nodeId: "node-1",
          containerName: "worker",
          displayName: "worker",
          sourceState: "running",
        }}
      />
    );

    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Target" }));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start migration" }));

    await waitFor(() =>
      expect(onCutover).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "cleanup_pending",
          targetNodeSlug: "target",
          targetResourceId: "target-container-id",
        })
      )
    );
  });

  it("restores migration progress after the detail route changes", async () => {
    const onCutover = vi.fn();
    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        onCutover={onCutover}
        initialMigration={{
          ...runningMigration,
          status: "completed",
          phase: "done",
          targetNodeSlug: "target",
          targetResourceId: "target-container-id",
          cutoverAt: new Date().toISOString(),
        }}
        resource={{
          type: "container",
          nodeId: "node-2",
          containerName: "worker",
          displayName: "worker",
          sourceState: "running",
        }}
      />
    );

    expect(await screen.findByRole("heading", { name: "Migration progress" })).toBeInTheDocument();
    expect(screen.getByText(/migration completed/i)).toBeInTheDocument();
    expect(api.listNodes).not.toHaveBeenCalled();
    expect(onCutover).not.toHaveBeenCalled();
  });

  it("does not expose proxy cutover as a separate progress phase", async () => {
    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        initialMigration={{
          ...runningMigration,
          phase: "proxy_cutover",
        }}
        resource={{
          type: "container",
          nodeId: "node-2",
          containerName: "worker",
          displayName: "worker",
          sourceState: "running",
        }}
      />
    );

    expect(await screen.findByText("Cutover")).toBeInTheDocument();
    expect(screen.queryByText("Proxy cutover")).not.toBeInTheDocument();
  });

  it("resolves a migration that needs attention with the side Gateway treats as authoritative", async () => {
    const resolved = { ...runningMigration, status: "failed" as const, phase: "done" };
    vi.spyOn(api, "resolveDockerMigration").mockResolvedValue(resolved);
    render(
      <DockerMigrationDialog
        open
        onOpenChange={vi.fn()}
        initialMigration={{
          ...runningMigration,
          status: "needs_attention",
          phase: "rollback",
          errorCode: "MIGRATION_ROLLBACK_FAILED",
          errorMessage: "Migration rollback could not confirm the target was removed",
        }}
        resource={{
          type: "container",
          nodeId: "node-1",
          containerName: "worker",
          displayName: "worker",
          sourceState: "running",
        }}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /resolve/i }));

    await waitFor(() =>
      expect(api.resolveDockerMigration).toHaveBeenCalledWith("migration-1", "source")
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /resolve/i })).not.toBeInTheDocument()
    );
  });
});
