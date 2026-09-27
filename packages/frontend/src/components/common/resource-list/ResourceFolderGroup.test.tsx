import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ResourceListForm } from "@/components/common/ResourceListForm";

interface TestFolder {
  id: string;
  name: string;
  items: string[];
}

function renderFolderList({
  onRenameFolder,
  onToggleFolder,
}: {
  onRenameFolder: (id: string, name: string) => Promise<void>;
  onToggleFolder: () => void;
}) {
  const folder: TestFolder = { id: "folder-1", name: "Production", items: ["api.example.com"] };
  render(
    <ResourceListForm<TestFolder, string>
      columns={[{ id: "name", label: "Name", renderCell: (item) => item }]}
      search={{ search: "", onSearchChange: () => {}, hasActiveFilters: false, onReset: () => {} }}
      folders={{
        folders: [folder],
        ungroupedItems: [],
        expandedFolderIds: new Set([folder.id]),
        getFolderId: (current) => current.id,
        getFolderName: (current) => current.name,
        getFolderChildren: () => [],
        getFolderItems: (current) => current.items,
        getFolderSortableId: (current) => `folder-${current.id}`,
        getFolderSortableData: () => ({}),
        canManageFolder: () => true,
        onToggleFolder,
        onRenameFolder,
      }}
      items={{
        getItemId: (item) => item,
        getItemSortableId: (item) => item,
        getItemSortableData: () => ({}),
      }}
      loading={false}
      hasContent
      emptyState={<div>Empty</div>}
    />
  );
}

it("renames a folder through the Rename Folder dialog", async () => {
  const user = userEvent.setup();
  const onRenameFolder = vi.fn().mockResolvedValue(undefined);
  const onToggleFolder = vi.fn();
  renderFolderList({ onRenameFolder, onToggleFolder });

  await user.click(screen.getByRole("button", { name: "Folder actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));

  const dialog = await screen.findByRole("dialog", { name: "Rename Folder" });
  const input = within(dialog).getByRole("textbox", { name: "Folder name" });
  expect(input).toHaveValue("Production");
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();

  await user.clear(input);
  await user.type(input, "Staging{Enter}");

  await waitFor(() => expect(onRenameFolder).toHaveBeenCalledWith("folder-1", "Staging"));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Rename Folder" })).not.toBeInTheDocument()
  );
  // Typing and submitting in the dialog never reaches the folder row behind it.
  expect(onToggleFolder).not.toHaveBeenCalled();
});

it("keeps the name when the Rename Folder dialog is cancelled", async () => {
  const user = userEvent.setup();
  const onRenameFolder = vi.fn().mockResolvedValue(undefined);
  renderFolderList({ onRenameFolder, onToggleFolder: vi.fn() });

  await user.click(screen.getByRole("button", { name: "Folder actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename Folder" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Rename Folder" })).not.toBeInTheDocument()
  );
  expect(onRenameFolder).not.toHaveBeenCalled();
  expect(screen.getByText("Production")).toBeInTheDocument();
});
