import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { PermissionGroup, User } from "@/types";
import { AdminUsers } from "./AdminUsers";

const realtime = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (channel: string, callback: () => void) => realtime.set(channel, callback),
}));
vi.mock("@/components/common/FolderedResourceList", () => ({
  FolderedResourceList: ({
    resources,
    columns,
  }: {
    resources: User[];
    columns: ResourceListColumn<User>[];
  }) => (
    <div>
      {resources.map((user) => (
        <div key={user.id}>
          {columns.find((column) => column.id === "group")?.renderCell?.(user)}
        </div>
      ))}
    </div>
  ),
}));

const groups = ["viewer", "operator", "admin"].map(
  (name) => ({ id: name, name, scopes: [] }) as unknown as PermissionGroup
);
const target = makeUser({
  id: "target",
  groupId: "viewer",
  groupName: "viewer",
  groupIds: ["viewer"],
  groupNames: ["viewer"],
});
function updated(ids: string[]): User {
  return { ...target, groupId: ids[0], groupName: ids[0], groupIds: ids, groupNames: ids };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function openGroups() {
  render(
    <MemoryRouter>
      <AdminUsers embedded />
    </MemoryRouter>
  );
  const input = await screen.findByRole("combobox", { name: "Permission groups" });
  await userEvent.click(input);
  return input;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(toast, "error").mockImplementation(() => "toast");
  realtime.clear();
  api.resetSessionState();
  useAuthStore.setState({ user: makeUser({ id: "actor", scopes: ["admin:users"] }) });
  vi.spyOn(api, "listUsers").mockResolvedValue([target]);
  vi.spyOn(api, "listGroups").mockResolvedValue(groups);
});

describe("AdminUsers group selection", () => {
  it("keeps the dropdown mounted through rapid changes and stale realtime responses", async () => {
    const first = deferred<User>();
    const second = deferred<User>();
    const save = vi
      .spyOn(api, "updateUserGroup")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const input = await openGroups();
    const option = screen.getByRole("button", { name: "operator" });
    const dropdown = option.closest(".dropdown-content");
    await userEvent.click(option);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(option).toHaveAttribute("aria-pressed", "true");
    expect(option.querySelector(".absolute.right-2 svg")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "admin" }));
    expect(save).toHaveBeenCalledTimes(1);
    const stale = deferred<User[]>();
    vi.mocked(api.listUsers).mockReturnValueOnce(stale.promise);
    act(() => realtime.get("user.changed")?.());
    await act(async () => first.resolve(updated(["viewer", "operator"])));
    expect(save).toHaveBeenLastCalledWith("target", ["viewer", "operator", "admin"]);
    await act(async () => second.resolve(updated(["viewer", "operator", "admin"])));
    await act(async () => stale.resolve([target]));
    expect(screen.getByRole("button", { name: "operator" }).closest(".dropdown-content")).toBe(
      dropdown
    );
    expect(input).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(input).toHaveValue("viewer, operator, admin");
    expect(input).toHaveClass("truncate");
  });

  it("rolls back to the last confirmed selection when a queued save fails", async () => {
    const first = deferred<User>();
    const second = deferred<User>();
    vi.spyOn(api, "updateUserGroup")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const input = await openGroups();
    await userEvent.click(screen.getByRole("button", { name: "operator" }));
    await userEvent.click(screen.getByRole("button", { name: "admin" }));
    await act(async () => first.resolve(updated(["viewer", "operator"])));
    await act(async () => second.reject(new Error("Save failed")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Save failed"));
    expect(input).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(input).toHaveValue("viewer, operator");
  });
});
