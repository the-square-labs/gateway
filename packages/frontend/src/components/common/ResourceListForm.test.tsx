import { render, screen, waitFor } from "@testing-library/react";
import { PageTransition } from "./PageTransition";
import { ResourceListForm } from "./ResourceListForm";

function List({ loading }: { loading: boolean }) {
  return (
    <PageTransition>
      <ResourceListForm<string, string>
        columns={[{ id: "name", label: "Name", renderCell: (item) => item }]}
        search={{
          search: "",
          onSearchChange: () => {},
          hasActiveFilters: false,
          onReset: () => {},
        }}
        folders={{
          folders: [],
          ungroupedItems: ["Existing resource"],
          expandedFolderIds: new Set(),
          getFolderId: (id) => id,
          getFolderName: (id) => id,
          getFolderChildren: () => [],
          getFolderItems: () => [],
          getFolderSortableId: (id) => id,
          getFolderSortableData: () => ({}),
          onToggleFolder: () => {},
        }}
        items={{
          getItemId: (id) => id,
          getItemSortableId: (id) => id,
          getItemSortableData: () => ({}),
        }}
        loading={loading}
        hasContent
        emptyState={<div>Empty</div>}
      />
    </PageTransition>
  );
}

it("waits for the initial folder data even with existing resources, then preserves the list during refresh", async () => {
  const { rerender } = render(<List loading />);
  const row = screen.getByText("Existing resource");
  expect(row).not.toBeVisible();
  rerender(<List loading={false} />);
  await waitFor(() => expect(row).toBeVisible());
  rerender(<List loading />);
  expect(screen.getByText("Existing resource")).toBe(row);
  expect(row).toBeVisible();
});
