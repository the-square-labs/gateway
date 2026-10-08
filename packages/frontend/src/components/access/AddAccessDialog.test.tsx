import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FolderOption } from "@/components/common/scope-list-helpers";
import { AccessPanel } from "./AccessPanel";
import { AddAccessDialog } from "./AddAccessDialog";
import type { AccessCatalog } from "./access-catalog";
import { ACCESS_TYPES, type AccessContext, type AccessLine, lineScopes } from "./access-model";

/** Folder `billing` in every tree but Domains. */
const ctx: AccessContext = {
  folders: ACCESS_TYPES.filter((type) => type.family !== "domains").map(
    (type): FolderOption => ({
      id: `${type.family}-billing`,
      label: "billing",
      family: type.family,
      ancestorIds: [],
    })
  ),
};

const catalog: AccessCatalog = {
  ready: true,
  ctx,
  labels: {},
  gitConnectors: {},
  resources: [],
  loadResources: () => undefined,
  rememberGitLabel: () => undefined,
};

function renderDialog(mode: Parameters<typeof AddAccessDialog>[0]["mode"]) {
  const onSave = vi.fn<(line: AccessLine) => void>();
  render(
    <AddAccessDialog
      open
      onOpenChange={() => undefined}
      subject="orders-team"
      line={null}
      catalog={catalog}
      mode={mode}
      onSave={onSave}
      onReviewScopes={() => undefined}
    />
  );
  return onSave;
}

describe("Add Access", () => {
  it("adds a role in a project folder, leaving out types without that folder", async () => {
    const onSave = renderDialog({ kind: "grant", actorScopes: [] });
    expect(screen.getByText("No folder billing for domains: it is left out.")).toBeInTheDocument();
    expect(screen.getByText(/You can't grant this/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add Access" }));
    const line = onSave.mock.calls[0]![0];
    expect(line).toEqual({
      kind: "resources",
      role: "developer",
      types: ACCESS_TYPES.map((type) => type.id).filter((type) => type !== "domains"),
      where: { kind: "folder", path: "billing" },
      mayDelete: false,
    });
    expect(
      screen.getByRole("button", { name: `Review ${lineScopes(line, ctx).length} scopes` })
    ).toBeInTheDocument();
  });

  it("says what a token line wider than its owner really does", () => {
    renderDialog({
      kind: "token",
      ownerScopes: [
        "docker:containers:view:folder/docker-billing",
        "docker:containers:manage:folder/docker-billing",
      ],
    });
    expect(screen.getByText("Works as Deployer: you are Deployer in billing")).toBeInTheDocument();
  });
});

describe("Access list", () => {
  it("edits own lines and only shows lines from a group", async () => {
    const onEdit = vi.fn();
    render(
      <AccessPanel
        description="Lines from a group change in that group."
        onAdd={() => undefined}
        onEdit={onEdit}
        onRemove={() => undefined}
        views={[
          {
            key: "own",
            index: 0,
            line: { kind: "custom", scopes: ["admin:audit"] },
            title: "Operator in folder orders / staging",
            detail: "Containers and deployments, databases",
          },
          {
            key: "group",
            line: { kind: "custom", scopes: ["admin:audit"] },
            title: "Viewer everywhere",
            detail: "All 8 resource types",
            from: "orders-team",
          },
        ]}
      />
    );
    expect(screen.getByText("All 8 resource types · from orders-team")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Viewer everywhere" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Operator in folder orders / staging" })
    );
    expect(onEdit).toHaveBeenCalledWith(0);
  });
});
