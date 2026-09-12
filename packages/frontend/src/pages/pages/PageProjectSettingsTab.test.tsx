import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { PageProject } from "@/types";
import { PageProjectSettingsDialog } from "./PageProjectSettingsTab";

const project: PageProject = {
  id: "project-1",
  name: "Demo",
  slug: "demo",
  description: null,
  appearanceColor: null,
  spaFallback: false,
  previewsEnabled: true,
  fallbackUrl: null,
  primaryDomain: null,
  nodeId: null,
  migrationSourceNodeId: null,
  migrationTargetNodeId: null,
  migrationStatus: null,
  migrationGeneration: 0,
  migrationError: null,
  folderId: null,
  sortOrder: 0,
  maxDeployments: 10,
  storageQuotaBytes: 1024 ** 3,
  storageUsedBytes: 0,
  nextDeploymentSequence: 1,
  deploymentCount: 0,
  tagCount: 0,
  routeCount: 0,
  createdById: "user-1",
  updatedById: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("PageProjectSettingsDialog public previews", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([
    true,
    false,
    undefined,
  ])("keeps previewsEnabled=%s local until Save and persists the new value", async (previewsEnabled) => {
    const user = userEvent.setup();
    const current = { ...project, previewsEnabled } as PageProject;
    const updated = { ...project, previewsEnabled: !(previewsEnabled ?? true) };
    const update = vi.spyOn(api, "updatePageProject").mockResolvedValue(updated);
    const onProjectChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PageProjectSettingsDialog
        project={current}
        open
        onProjectChange={onProjectChange}
        onOpenChange={onOpenChange}
      />
    );

    const toggle = screen.getByRole("button", { name: "Enable public previews" });
    expect(toggle).toHaveAttribute("aria-pressed", String(previewsEnabled ?? true));
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", String(updated.previewsEnabled));
    expect(update).not.toHaveBeenCalled();
    expect(onProjectChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(updated));
    expect(update).toHaveBeenCalledExactlyOnceWith(project.id, {
      name: project.name,
      description: null,
      appearanceColor: null,
      spaFallback: false,
      previewsEnabled: updated.previewsEnabled,
      fallbackUrl: null,
      maxDeployments: 10,
      storageQuotaBytes: 1024 ** 3,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves true for an untouched legacy project without the field", async () => {
    const user = userEvent.setup();
    const { previewsEnabled: _previewsEnabled, ...legacy } = project;
    const update = vi.spyOn(api, "updatePageProject").mockResolvedValue(project);
    render(
      <PageProjectSettingsDialog
        project={legacy as PageProject}
        open
        onProjectChange={vi.fn()}
        onOpenChange={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(update).toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ previewsEnabled: true })
    );
  });

  it("discards an unsaved toggle when cancelled and reopened", async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(api, "updatePageProject").mockResolvedValue(project);
    const onOpenChange = vi.fn();
    const onProjectChange = vi.fn();
    const props = { project, onOpenChange, onProjectChange };
    const { rerender } = render(<PageProjectSettingsDialog {...props} open />);
    await user.click(screen.getByRole("button", { name: "Enable public previews" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(update).not.toHaveBeenCalled();
    expect(onProjectChange).not.toHaveBeenCalled();
    rerender(<PageProjectSettingsDialog {...props} open={false} />);
    rerender(<PageProjectSettingsDialog {...props} open />);
    expect(screen.getByRole("button", { name: "Enable public previews" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("leaves the saved project unchanged when saving fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "updatePageProject").mockRejectedValue(new Error("Save failed"));
    const error = vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    const onOpenChange = vi.fn();
    const onProjectChange = vi.fn();
    render(
      <PageProjectSettingsDialog
        project={project}
        open
        onOpenChange={onOpenChange}
        onProjectChange={onProjectChange}
      />
    );
    await user.click(screen.getByRole("button", { name: "Enable public previews" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Save failed"));
    expect(onProjectChange).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Enable public previews" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });
});
