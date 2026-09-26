import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { PageProject } from "@/types";
import { PageProjectSettingsDialog } from "./PageProjectSettingsTab";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn(async () => true) }));

const project = {
  id: "project-1",
  name: "Demo",
  slug: "demo",
  previewHash: "abcdefghijkl",
  accessListId: null,
  description: null,
  appearanceColor: null,
  spaFallback: false,
  previewsEnabled: true,
  fallbackUrl: null,
  maxDeployments: 10,
  storageQuotaBytes: 1024 ** 3,
} as PageProject;

function Host() {
  const [current, setCurrent] = useState(project);
  return (
    <PageProjectSettingsDialog
      project={current}
      open
      onOpenChange={vi.fn()}
      onProjectChange={setCurrent}
    />
  );
}

describe("PageProjectSettingsDialog link rotation", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps unsaved edits when a rotation refreshes the Project", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listAccessLists").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    } as never);
    const rotate = vi.spyOn(api, "rotatePagePreviewHash").mockResolvedValue({
      project: { ...project, previewHash: "zzzzzzzzzzzz", name: "Demo" },
      rotation: { revokedHostnames: 1, cleanupPendingHostnames: 0, republishFailures: 0 },
    });
    render(<Host />);

    const name = await screen.findByPlaceholderText("My static site");
    await user.clear(name);
    await user.type(name, "Renamed but not saved");
    await user.click(screen.getByRole("button", { name: "Rotate preview links" }));

    await waitFor(() => expect(rotate).toHaveBeenCalledWith("project-1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Rotate preview links" })).toBeEnabled()
    );
    expect(screen.getByPlaceholderText("My static site")).toHaveValue("Renamed but not saved");
  });

  it("loads every page of access lists", async () => {
    const list = vi.spyOn(api, "listAccessLists").mockImplementation(
      async (params) =>
        ({
          data: [{ id: `acl-${params?.page}`, name: `List ${params?.page}` }],
          pagination: { page: params?.page ?? 1, limit: 100, total: 2, totalPages: 2 },
        }) as never
    );
    render(<Host />);

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls.map(([params]) => params?.page)).toEqual([1, 2]);
  });
});
