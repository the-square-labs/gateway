import { act, render as renderView, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { beforeEach, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { HostingSnapshotChangedEvent, HostingSnapshotsView } from "@/types/hosting";
import { NodeSnapshotsTab } from "./NodeSnapshotsTab";

const realtime = vi.hoisted(() => ({
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
}));
const listForm = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/components/common/ResourceListForm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/common/ResourceListForm")>();
  const React = await import("react");
  return {
    ...original,
    ResourceListForm: (props: any) => {
      listForm.current = props;
      return React.createElement(original.ResourceListForm, props);
    },
  };
});

vi.mock("@/hooks/use-realtime", async () => {
  const React = await import("react");
  return {
    useRealtime: (
      channel: string | null,
      handler: (payload: unknown) => void,
      options: { onReconnect?: () => void } = {}
    ) => {
      const handlerRef = React.useRef(handler);
      handlerRef.current = handler;
      React.useEffect(() => {
        if (!channel) return;
        let handlers = realtime.handlers.get(channel);
        if (!handlers) {
          handlers = new Set();
          realtime.handlers.set(channel, handlers);
        }
        const callback = (payload: unknown) => handlerRef.current(payload);
        handlers.add(callback);
        return () => {
          handlers?.delete(callback);
          if (handlers?.size === 0) realtime.handlers.delete(channel);
        };
      }, [channel]);
      void options;
    },
  };
});

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn(async () => true) }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const render = (ui: ReactElement) => renderView(ui, { wrapper: MemoryRouter });
beforeEach(() => {
  realtime.handlers.clear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.loading).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.dismiss).mockClear();
  vi.spyOn(api, "getHostingSnapshotFolders").mockResolvedValue([]);
});

function emitSnapshotEvent(event: HostingSnapshotChangedEvent) {
  for (const handler of realtime.handlers.get("hosting.snapshot.changed") ?? []) handler(event);
}
it("moves a provider snapshot through the shared folder list using its entity UUID", async () => {
  const entityId = "11111111-1111-4111-8111-111111111111";
  const folderId = "22222222-2222-4222-8222-222222222222";
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    canManageFolders: true,
    snapshots: [
      { ...view.snapshots[0], entityId, id: "provider-123", providerSnapshotId: "provider-123" },
    ],
  });
  const move = vi.spyOn(api, "hostingSnapshotFolderAction").mockResolvedValue(undefined);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  const resource = listForm.current.folders.ungroupedItems[0];
  expect(resource.id).toBe(entityId);
  await act(async () =>
    listForm.current.dnd.onDragEnd({
      active: { id: entityId, data: { current: { type: "resource", resource } } },
      over: { id: folderId, data: { current: { type: "folder", folderId } } },
    })
  );
  await waitFor(() =>
    expect(move).toHaveBeenCalledWith("vm", "move-resources", { ids: [entityId], folderId })
  );
});
it("refreshes snapshot placements on a matching folder event without clearing rows", async () => {
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  const before = screen.getByText("before");
  const reads = get.mock.calls.length;
  await act(async () => {
    for (const handler of realtime.handlers.get("hosting.snapshot.folder.changed") ?? [])
      handler({ resourceId: "vm", incarnation: "original" });
  });
  expect(get).toHaveBeenCalledTimes(reads + 1);
  expect(screen.getByText("before")).toBe(before);
});
it("reports snapshot loading failures through Sonner rather than an inline message", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockRejectedValue(
    new Error("Snapshot inventory unavailable")
  );
  render(<NodeSnapshotsTab resourceId="vm" />);
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Snapshot inventory unavailable", expect.anything())
  );
  expect(screen.queryByText("Snapshot inventory unavailable")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
});
it("does not emit progress or loading toasts while a snapshot is provisioning", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    busy: true,
    operation: {
      id: "in-progress-ui",
      resourceId: "vm",
      action: "snapshot_create",
      phase: "provisioning",
    } as HostingSnapshotsView["operation"],
    readModel: {
      refreshStatus: "never",
      availability: "unknown",
      lastError: null,
      observedAt: null,
    },
  });
  const { unmount } = render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  expect(toast.loading).not.toHaveBeenCalled();
  unmount();
  expect(toast.dismiss).not.toHaveBeenCalled();
  useAuthStore.setState({ user: makeUser({ id: "changed-after-progress-test" }) });
});
it("distinguishes a cold snapshot read model from an empty provider inventory", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    snapshots: [],
    canCreate: false,
    canDelete: false,
    canRestore: false,
    reason: "Snapshot information is refreshing or unavailable",
    readModel: {
      refreshStatus: "never",
      availability: "unknown",
      lastError: null,
      observedAt: null,
    },
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("Waiting for snapshot inventory");
  expect(toast.loading).not.toHaveBeenCalled();
  expect(screen.queryByText("Snapshot inventory")).not.toBeInTheDocument();
  expect(screen.getByText("Waiting for snapshot inventory")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
  expect(screen.queryByText("No snapshots yet")).not.toBeInTheDocument();
});
it("retains rows through background refresh and replaces them only when the new inventory arrives", async () => {
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  let resolve!: (value: HostingSnapshotsView) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await userEvent.click(screen.getByRole("button", { name: "Refresh snapshots" }));
  expect(screen.getByText("before")).toBeInTheDocument();
  await act(async () => resolve({ ...view, snapshots: [] }));
  await screen.findByText("No snapshots yet");
  expect(screen.queryByText("before")).not.toBeInTheDocument();
});
it("does not show a refresh progress toast after a previous snapshot operation has completed", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    operation: {
      id: "old-completed",
      resourceId: "vm",
      action: "snapshot_delete",
      phase: "ready",
    } as HostingSnapshotsView["operation"],
    readModel: {
      refreshStatus: "refreshing",
      availability: "unknown",
      lastError: null,
      observedAt: null,
    },
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  expect(toast.loading).not.toHaveBeenCalled();
});
it("shows estimated storage and uses the standard folder creation dialog", async () => {
  const folder = {
    id: "folder",
    name: "Before upgrade",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    createdAt: "2026-09-07",
    updatedAt: "2026-09-07",
    children: [],
  };
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    canManageFolders: true,
    snapshots: [
      {
        ...view.snapshots[0],
        monthlyCost: { amount: "0.12", currency: "USD", estimated: true, tax: "unspecified" },
        storageRate: {
          amount: "0.06",
          currency: "USD",
          unit: "GB-month",
          source: "published-rate",
        },
      },
    ],
  });
  const create = vi.spyOn(api, "hostingSnapshotFolderAction").mockResolvedValue(folder as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("0.12 USD / month");
  expect(screen.queryByText(/GB-month/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Add Folder" }));
  await userEvent.type(screen.getByPlaceholderText("Folder name"), "Before upgrade");
  await userEvent.click(screen.getByRole("button", { name: /^create/i }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith("vm", "create", {
      name: "Before upgrade",
      parentId: undefined,
    })
  );
});
const view = {
  resourceId: "vm",
  incarnation: "original",
  provider: "hetzner",
  powerState: "stopped",
  supported: true,
  reason: null,
  snapshots: [
    {
      id: "100",
      entityId: "entity-100",
      providerSnapshotId: "100",
      status: "ready",
      operationId: null,
      error: null,
      includeRam: false,
      revision: "2026-09-07T10:00:00.000Z",
      name: "before",
      fingerprint: "a".repeat(64),
      createdAt: null,
      sizeGb: 2,
      minDiskGb: 20,
      ready: true,
    },
  ],
  operation: null,
  canCreate: true,
  canDelete: true,
  canRestore: true,
} as HostingSnapshotsView;
it("opens snapshot details using the shared interactive row and read-only detail rows", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider: "proxmox",
    canCreate: false,
    canDelete: false,
    canRestore: false,
    snapshots: [{ ...view.snapshots[0], includeRam: true }],
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  const name = await screen.findByText("before");
  expect(name.closest("tr")).toHaveClass("cursor-pointer", "hover:bg-accent");
  await userEvent.click(name);
  const dialog = screen.getByRole("dialog", { name: "Snapshot details" });
  expect(within(dialog).getByText("100")).toBeInTheDocument();
  expect(within(dialog).getByText("2 GB")).toBeInTheDocument();
  expect(within(dialog).getByText("20 GB")).toBeInTheDocument();
  expect(within(dialog).getByText("Yes")).toBeInTheDocument();
  expect(within(dialog).queryByText("Est. monthly storage")).not.toBeInTheDocument();
  expect(within(dialog).getByText("Name")).toHaveClass("text-sm", "text-muted-foreground");
  await userEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("retains snapshot details throughout the dialog exit animation", async ({ onTestFinished }) => {
  const getComputedStyle = window.getComputedStyle.bind(window);
  const stylesSpy = vi
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element, pseudoElement) => {
      const styles = getComputedStyle(element, pseudoElement);
      if (
        !element.classList.contains("dialog-content") &&
        !element.classList.contains("dialog-overlay")
      )
        return styles;
      return new Proxy(styles, {
        get(target, property) {
          if (property === "animationName")
            return element.getAttribute("data-state") === "closed"
              ? "snapshot-exit"
              : "snapshot-enter";
          return Reflect.get(target, property);
        },
      });
    });
  onTestFinished(() => stylesSpy.mockRestore());
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await userEvent.click(await screen.findByText("before"));
  const dialog = screen.getByRole("dialog", { name: "Snapshot details" });
  await userEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
  expect(dialog).toBeInTheDocument();
  expect(dialog).toHaveAttribute("data-state", "closed");
  expect(within(dialog).getByText("before")).toBeInTheDocument();
  expect(within(dialog).getByText("100")).toBeInTheDocument();
  expect(within(dialog).getByText("2 GB")).toBeInTheDocument();
});

it("updates open snapshot details from realtime without refetching and closes on deletion", async () => {
  const source = {
    ...view.snapshots[0],
    status: "pending" as const,
    ready: false,
    sizeGb: null,
    providerSnapshotId: null,
  };
  const get = vi
    .spyOn(api, "getHostingSnapshots")
    .mockResolvedValue({ ...view, snapshots: [source] });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await userEvent.click(await screen.findByText("before"));
  const dialog = screen.getByRole("dialog", { name: "Snapshot details" });
  expect(within(dialog).getByText("Pending")).toBeInTheDocument();
  expect(within(dialog).queryByText("Unavailable")).not.toBeInTheDocument();
  expect(within(dialog).queryByText("RAM included")).not.toBeInTheDocument();
  const reads = get.mock.calls.length;
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      operation: null,
      snapshot: {
        ...source,
        status: "ready",
        ready: true,
        providerSnapshotId: "100",
        sizeGb: 2.72,
        monthlyCost: { amount: "0.160000", currency: "USD", estimated: true, tax: "unspecified" },
        revision: "2026-09-07T10:00:01.000Z",
      },
    })
  );
  expect(within(dialog).getByText("Ready")).toBeInTheDocument();
  expect(within(dialog).getByText("0.16 USD / month")).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(reads);
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      operation: null,
      snapshot: { ...source, status: "deleted", revision: "2026-09-07T10:00:02.000Z" },
    })
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each([
  "Restore",
  "Delete before",
])("does not open snapshot details when clicking %s", async (name) => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  vi.mocked(confirm).mockResolvedValueOnce(false);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name }));
  expect(screen.queryByRole("dialog", { name: "Snapshot details" })).not.toBeInTheDocument();
});

it("clears snapshot details when switching VM", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockImplementation(async (id) => ({
    ...view,
    resourceId: id,
  }));
  const { rerender } = render(<NodeSnapshotsTab resourceId="vm" />);
  await userEvent.click(await screen.findByText("before"));
  expect(screen.getByRole("dialog", { name: "Snapshot details" })).toBeInTheDocument();
  rerender(<NodeSnapshotsTab resourceId="other-vm" />);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it.each([
  false,
  true,
])("embeds the foldered list like inference users, with one shell border (empty=%s)", async (empty) => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    snapshots: empty ? [] : view.snapshots,
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText(empty ? "No snapshots yet" : "before");
  const search = screen.getByPlaceholderText("Search snapshots...");
  const shell = screen
    .getByRole("heading", { name: "Snapshots" })
    .closest(".bg-card.overflow-hidden")!;
  expect(shell).toContainElement(search);
  expect(shell.lastElementChild).not.toHaveClass("p-4");
  expect(search).toHaveClass("h-12", "border-0", "focus-visible:ring-inset");
  expect(search.closest(".border-b")).toBeInTheDocument();
  expect(shell.firstElementChild).toContainElement(
    screen.getByRole("button", { name: "Create snapshot" })
  );
  const content = screen.getByText(empty ? "No snapshots yet" : "before");
  if (!empty) {
    expect(content).not.toHaveClass("text-sm");
    expect(content.closest(".overflow-x-auto")).toHaveClass("text-sm");
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toHaveClass("h-9", "w-9");
    expect(screen.getByRole("button", { name: "Delete before" })).not.toHaveClass("bg-destructive");
  }
  let borders = 0;
  for (let parent = content.parentElement; parent; parent = parent.parentElement) {
    if (parent.classList.contains("border")) borders++;
  }
  expect(borders).toBe(1);
});
it("does not send a destructive operation through a newly active session", async () => {
  useAuthStore.setState({ user: makeUser({ id: "first", scopes: ["nodes:details"] }) });
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const action = vi.spyOn(api, "hostingSnapshotAction");
  let resolve!: (value: boolean) => void;
  vi.mocked(confirm).mockReturnValueOnce(
    new Promise<boolean>((r) => {
      resolve = r;
    })
  );
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  await act(async () => {
    useAuthStore.setState({ user: makeUser({ id: "second", scopes: ["nodes:details"] }) });
    resolve(true);
  });
  expect(action).not.toHaveBeenCalled();
});
it("confirms data replacement and sends the exact snapshot identity", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const action = vi
    .spyOn(api, "hostingSnapshotAction")
    .mockResolvedValue({ action: "snapshot_restore", phase: "pending" } as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      "vm",
      expect.objectContaining({
        action: "snapshot_restore",
        snapshotId: "100",
        snapshotFingerprint: "a".repeat(64),
        expectedIncarnation: "original",
        confirmed: true,
      })
    )
  );
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      variant: "destructive",
      description: expect.stringContaining("Data written after the snapshot will be lost"),
    })
  );
});
it("keeps restore disabled while the provider VM is running", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    powerState: "running",
    canRestore: false,
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
});
it("allows running Proxmox restore with a disruption warning and no manual shutdown instruction", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider: "proxmox",
    powerState: "running",
    canRestore: true,
  });
  const action = vi.spyOn(api, "hostingSnapshotAction");
  vi.mocked(confirm).mockResolvedValueOnce(false);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore).toBeEnabled();
  await userEvent.click(restore);
  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      variant: "destructive",
      description: expect.stringContaining("Proxmox stops the VM as part of rollback"),
    })
  );
  expect(screen.queryByText(/Shut down the VM before restoring/)).not.toBeInTheDocument();
  expect(action).not.toHaveBeenCalled();
});
it("opens snapshot creation for a running Proxmox VM without a shutdown", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider: "proxmox",
    powerState: "running",
    canRestore: false,
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  const dialog = screen.getByRole("dialog", { name: "Create VM snapshot" });
  expect(dialog).toHaveClass("sm:max-w-md");
  const input = within(dialog).getByPlaceholderText("Snapshot name");
  expect(input).toBeEnabled();
  expect(input.parentElement).toBe(dialog.querySelector("[data-dialog-body]"));
  expect(input).toHaveFocus();
  expect(within(dialog).queryByText(/shut down|storage charges/i)).not.toBeInTheDocument();
  const action = vi
    .spyOn(api, "hostingSnapshotAction")
    .mockResolvedValue({ action: "snapshot_create", phase: "pending" } as never);
  await userEvent.type(input, "   {Enter}");
  expect(action).not.toHaveBeenCalled();
  await userEvent.clear(input);
  await userEvent.type(input, "Before upgrade{Enter}");
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      "vm",
      expect.objectContaining({ action: "snapshot_create", name: "Before upgrade" })
    )
  );
});
it("does not enable creation without snapshot permission even for a stopped VM", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider: "proxmox",
    canCreate: false,
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
});
it("uses the Docker deployment toggle block and sends RAM only when selected for Proxmox", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider: "proxmox",
    powerState: "running",
  });
  const action = vi
    .spyOn(api, "hostingSnapshotAction")
    .mockResolvedValue({ action: "snapshot_create", phase: "pending" } as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  const toggle = screen.getByRole("button", { name: "Include RAM" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(toggle.parentElement).toHaveClass(
    "flex",
    "items-center",
    "justify-between",
    "gap-4",
    "border",
    "border-border",
    "bg-muted/30",
    "p-3"
  );
  await userEvent.click(toggle);
  await userEvent.type(screen.getByPlaceholderText("Snapshot name"), "With memory{Enter}");
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(
      "vm",
      expect.objectContaining({ includeRam: true, name: "With memory" })
    )
  );
});
it.each([
  "hetzner",
  "digitalocean",
  "hostkey",
] as const)("does not show or send the Proxmox RAM option for %s", async (provider) => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({ ...view, provider });
  const action = vi
    .spyOn(api, "hostingSnapshotAction")
    .mockResolvedValue({ action: "snapshot_create", phase: "pending" } as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  expect(screen.queryByRole("button", { name: "Include RAM" })).not.toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText("Snapshot name"), "Disk only{Enter}");
  await waitFor(() => expect(action).toHaveBeenCalled());
  expect(action.mock.lastCall?.[1]).not.toHaveProperty("includeRam");
});
it("resets RAM on reopening and disables selecting it for a stopped Proxmox VM", async () => {
  const get = vi
    .spyOn(api, "getHostingSnapshots")
    .mockResolvedValue({ ...view, provider: "proxmox", powerState: "running" });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  await userEvent.click(screen.getByRole("button", { name: "Include RAM" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  get.mockResolvedValue({ ...view, provider: "proxmox", powerState: "stopped" });
  await userEvent.click(screen.getByRole("button", { name: "Refresh snapshots" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled()
  );
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  expect(screen.getByRole("button", { name: "Include RAM" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Include RAM" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});
it("does not mutate after destructive confirmation is declined", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const action = vi.spyOn(api, "hostingSnapshotAction");
  vi.mocked(confirm).mockResolvedValueOnce(false);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Delete before" }));
  expect(action).not.toHaveBeenCalled();
});
it("does not restore the old VM if the node changes during confirmation", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockImplementation(async (id) => ({
    ...view,
    resourceId: id,
  }));
  const action = vi.spyOn(api, "hostingSnapshotAction");
  let resolve!: (value: boolean) => void;
  vi.mocked(confirm).mockReturnValueOnce(
    new Promise<boolean>((r) => {
      resolve = r;
    })
  );
  const { rerender } = render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  rerender(<NodeSnapshotsTab resourceId="another-vm" />);
  resolve(true);
  await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled());
  expect(action).not.toHaveBeenCalled();
});

it("renders an optimistic pending entity before create returns and closes the dialog", async () => {
  let resolveAction!: (value: unknown) => void;
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const action = vi
    .spyOn(api, "hostingSnapshotAction")
    .mockImplementation(() => new Promise((resolve) => (resolveAction = resolve)) as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  await userEvent.type(screen.getByPlaceholderText("Snapshot name"), "optimistic");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));

  expect(screen.queryByRole("dialog", { name: "Create VM snapshot" })).not.toBeInTheDocument();
  expect(screen.getByText("optimistic")).toBeInTheDocument();
  expect(screen.getByText("Pending")).toBeInTheDocument();
  expect(action).toHaveBeenCalledWith(
    "vm",
    expect.objectContaining({ action: "snapshot_create", name: "optimistic" })
  );
  expect(action.mock.lastCall?.[1].idempotencyKey).toBeTruthy();
  resolveAction({ action: "snapshot_create", phase: "pending" });
});

it("rekeys the optimistic row when an idempotent replay returns a canonical entity id", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  vi.spyOn(api, "hostingSnapshotAction").mockResolvedValue({
    id: "operation-1",
    action: "snapshot_create",
    phase: "pending",
    result: { snapshotEntityId: "canonical-entity" },
  } as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  await userEvent.type(screen.getByPlaceholderText("Snapshot name"), "replayed");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  await screen.findByText("replayed");

  const source = view.snapshots[0];
  const {
    monthlyCost: _monthlyCost,
    storageRate: _storageRate,
    ...eventSnapshot
  } = {
    ...source,
    id: "canonical-entity",
    entityId: "canonical-entity",
    providerSnapshotId: null,
    name: "replayed",
    status: "ready" as const,
    operationId: "operation-1",
    error: null,
    revision: "2026-09-07T10:00:02.000Z",
  };
  await act(async () => {
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: eventSnapshot,
      operation: null,
    });
  });
  expect(screen.getAllByText("replayed")).toHaveLength(1);
  expect(screen.getAllByText("Ready")).toHaveLength(2);
});

it.each([
  "digitalocean",
  "hetzner",
] as const)("updates %s snapshot price from the completion event without reloading the list", async (provider) => {
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    provider,
    snapshots: [{ ...view.snapshots[0], status: "pending", monthlyCost: undefined }],
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("Pending");
  const rowBefore = screen.getByText("before");
  expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  const reads = get.mock.calls.length;
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: {
        ...view.snapshots[0],
        status: "ready",
        sizeGb: 2.72,
        revision: "2026-09-08T00:00:01.000Z",
        monthlyCost: { amount: "0.16", currency: "USD", estimated: true, tax: "unspecified" },
        storageRate: {
          amount: "0.06",
          currency: "USD",
          unit: "GB-month",
          source: "published-rate",
        },
      },
    })
  );
  expect(screen.getByText("0.16 USD / month")).toBeInTheDocument();
  expect(screen.getByText("before")).toBe(rowBefore);
  expect(screen.queryByText(/GB-month/)).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(reads);
  expect(toast.loading).not.toHaveBeenCalled();
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: { ...view.snapshots[0], status: "pending", revision: "2026-09-07T10:00:00.000Z" },
    })
  );
  expect(screen.getByText("0.16 USD / month")).toBeInTheDocument();
});

it("merges success and failure events by entity id, retaining row pricing", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    snapshots: [
      {
        ...view.snapshots[0],
        monthlyCost: { amount: "0.12", currency: "USD", estimated: true, tax: "unspecified" },
        storageRate: {
          amount: "0.06",
          currency: "USD",
          unit: "GB-month",
          source: "published-rate",
        },
      },
    ],
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("0.12 USD / month");
  const {
    monthlyCost: _monthlyCost,
    storageRate: _storageRate,
    ...baseEventSnapshot
  } = {
    ...view.snapshots[0],
  };
  await act(async () => {
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: {
        ...baseEventSnapshot,
        status: "failed",
        error: "Provider rejected snapshot",
        revision: "2026-09-07T10:00:01.000Z",
      },
      operation: null,
    });
  });
  expect(screen.getByText("Failed")).toBeInTheDocument();
  expect(screen.getByText("0.12 USD / month")).toBeInTheDocument();
  expect(toast.error).toHaveBeenCalledWith(
    "Provider rejected snapshot",
    expect.objectContaining({ id: expect.stringContaining("snapshot:entity-100") })
  );

  await act(async () => {
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: {
        ...baseEventSnapshot,
        status: "ready",
        error: null,
        revision: "2026-09-07T10:00:02.000Z",
      },
      operation: null,
    });
  });
  expect(screen.getByText("Ready")).toBeInTheDocument();
});

it("allows failed entity cleanup without sending an invalid provider fingerprint", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    snapshots: [
      {
        ...view.snapshots[0],
        entityId: "failed-entity",
        id: "failed-entity",
        providerSnapshotId: null,
        status: "failed",
        fingerprint: "client-generated-uuid",
        error: "provider failed before snapshot creation",
      },
    ],
  });
  const action = vi.spyOn(api, "hostingSnapshotAction").mockResolvedValue({
    id: "delete-operation",
    action: "snapshot_delete",
    phase: "pending",
  } as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("Failed");
  await userEvent.click(screen.getByRole("button", { name: "Delete before" }));
  await waitFor(() => expect(action).toHaveBeenCalled());
  expect(action.mock.lastCall?.[1]).toEqual(
    expect.objectContaining({ snapshotEntityId: "failed-entity" })
  );
  expect(action.mock.lastCall?.[1]).not.toHaveProperty("snapshotFingerprint");
});

it("publishes an optimistic restoring operation and disables duplicate restore", async () => {
  let resolveAction!: (value: unknown) => void;
  const onOperationChange = vi.fn();
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  vi.spyOn(api, "hostingSnapshotAction").mockImplementation(
    () => new Promise((resolve) => (resolveAction = resolve)) as never
  );
  render(<NodeSnapshotsTab resourceId="vm" onOperationChange={onOperationChange} />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Restore" }));
  expect(onOperationChange).toHaveBeenCalledWith(
    expect.objectContaining({ action: "snapshot_restore", phase: "pending" })
  );
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  expect(actionInput()).toEqual(expect.objectContaining({ snapshotEntityId: "entity-100" }));
  resolveAction({ id: "restore-operation", action: "snapshot_restore", phase: "pending" });
});

it("keeps delete labelled and all mutations locked after admission during an inventory refresh", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const operation = {
    id: "delete-operation",
    action: "snapshot_delete",
    phase: "pending",
    updatedAt: "2026-09-07T10:00:01.000Z",
    result: { snapshotEntityId: "entity-100" },
  } as const;
  vi.spyOn(api, "hostingSnapshotAction").mockResolvedValue(operation as never);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Delete before" }));
  await screen.findByText("Deleting");
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: { ...view.snapshots[0], revision: "2026-09-07T10:00:00.500Z" },
    })
  );
  expect(screen.getByText("Deleting")).toBeInTheDocument();
  expect(screen.queryByText("Creating")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete before" })).toBeDisabled();
  expect(toast.loading).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});

it.each([
  "snapshot_create",
  "snapshot_delete",
  "snapshot_restore",
] as const)("locks create, restore and delete until %s finishes via the event bus", async (action) => {
  const operation = {
    id: "active-operation",
    action,
    phase: "provisioning" as const,
    updatedAt: "2026-09-07T10:00:01.000Z",
    errorMessage: null,
  };
  const snapshot = {
    ...view.snapshots[0],
    status:
      action === "snapshot_create"
        ? ("pending" as const)
        : action === "snapshot_delete"
          ? ("deleting" as const)
          : ("ready" as const),
    operationId: operation.id,
  };
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    busy: true,
    operation,
    snapshots: [snapshot],
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  for (const name of ["Create snapshot", "Restore", "Delete before"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  const reads = get.mock.calls.length;
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: {
        ...snapshot,
        status: action === "snapshot_delete" ? "deleted" : "ready",
        revision: "2026-09-07T10:00:02.000Z",
      },
      operation: { ...operation, phase: "ready", updatedAt: "2026-09-07T10:00:02.000Z" },
    })
  );
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
  if (action === "snapshot_delete") expect(screen.queryByText("before")).not.toBeInTheDocument();
  else
    for (const name of ["Restore", "Delete before"])
      expect(screen.getByRole("button", { name })).toBeEnabled();
  expect(get).toHaveBeenCalledTimes(reads);
  expect(toast.loading).not.toHaveBeenCalled();
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not re-lock a completed deletion when its admission HTTP response arrives late", async () => {
  let resolveAction!: (value: unknown) => void;
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  vi.spyOn(api, "hostingSnapshotAction").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveAction = resolve;
      }) as never
  );
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Delete before" }));
  const operation = {
    id: "delete-operation",
    action: "snapshot_delete" as const,
    phase: "ready" as const,
    errorMessage: null,
    updatedAt: "2026-09-07T10:00:02.000Z",
  };
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: { ...view.snapshots[0], status: "deleted", revision: operation.updatedAt },
      operation,
    })
  );
  await act(async () =>
    resolveAction({ ...operation, phase: "pending", updatedAt: "2026-09-07T10:00:01.000Z" })
  );
  expect(screen.queryByText("before")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
});

it("does not submit after another operation starts while the confirmation is open", async () => {
  let resolveConfirm!: (confirmed: boolean) => void;
  vi.mocked(confirm).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveConfirm = resolve;
      })
  );
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  const post = vi.spyOn(api, "hostingSnapshotAction");
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Delete before" }));
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: view.snapshots[0],
      operation: {
        id: "other-restore",
        action: "snapshot_restore",
        phase: "pending",
        updatedAt: "2026-09-07T10:00:01.000Z",
        errorMessage: null,
      },
    })
  );
  await act(async () => resolveConfirm(true));
  expect(post).not.toHaveBeenCalled();
  for (const name of ["Create snapshot", "Restore", "Delete before"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
});

it("clears pending busy state from a terminal event without another list GET", async () => {
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    busy: true,
    snapshots: [{ ...view.snapshots[0], status: "pending" }],
    operation: {
      id: "create-operation",
      connectorId: null,
      resourceId: "vm",
      nodeId: null,
      action: "snapshot_create",
      phase: "provisioning",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-09-07T10:00:00.000Z",
      updatedAt: "2026-09-07T10:00:00.000Z",
      completedAt: null,
      result: null,
    },
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("Pending");
  const callsBeforeEvent = get.mock.calls.length;
  const {
    monthlyCost: _monthlyCost,
    storageRate: _storageRate,
    ...eventSnapshot
  } = {
    ...view.snapshots[0],
    status: "ready" as const,
    revision: "2026-09-07T10:00:02.000Z",
  };
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: eventSnapshot,
      operation: {
        id: "create-operation",
        action: "snapshot_create",
        phase: "ready",
        errorMessage: null,
        updatedAt: "2026-09-07T10:00:02.000Z",
      },
    })
  );
  expect(get).toHaveBeenCalledTimes(callsBeforeEvent);
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
  expect(screen.getByText("Ready")).toBeInTheDocument();
});

it("applies terminal restore state even when the snapshot revision has not changed", async () => {
  const onOperationChange = vi.fn();
  const pending = {
    id: "restore",
    action: "snapshot_restore",
    phase: "pending",
    updatedAt: "2026-09-07T10:00:00.000Z",
    errorMessage: null,
  } as const;
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    busy: true,
    operation: pending,
  });
  render(<NodeSnapshotsTab resourceId="vm" onOperationChange={onOperationChange} />);
  await screen.findByText("before");
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: view.snapshots[0],
      operation: { ...pending, phase: "ready", updatedAt: "2026-09-07T10:00:01.000Z" },
    })
  );
  expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  expect(onOperationChange).toHaveBeenLastCalledWith(null);
});

it("does not clear an active VM operation on a background snapshot-only event", async () => {
  vi.spyOn(api, "getHostingSnapshots").mockResolvedValue({
    ...view,
    busy: true,
    operation: {
      id: "resize",
      action: "resize",
      phase: "pending",
      updatedAt: "2026-09-07T10:00:00.000Z",
      errorMessage: null,
    },
  });
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await act(async () =>
    emitSnapshotEvent({
      resourceId: "vm",
      incarnation: "original",
      snapshot: { ...view.snapshots[0], revision: "2026-09-07T10:00:02.000Z" },
    })
  );
  expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
});

it("reconciles events received before the initial list request finishes", async () => {
  let resolveInitial!: (value: HostingSnapshotsView) => void;
  const latest = { ...view, snapshots: [{ ...view.snapshots[0], name: "arrived-during-load" }] };
  const get = vi
    .spyOn(api, "getHostingSnapshots")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        })
    )
    .mockResolvedValue(latest);
  render(<NodeSnapshotsTab resourceId="vm" />);
  await act(async () =>
    emitSnapshotEvent({ resourceId: "vm", incarnation: "original", snapshot: latest.snapshots[0] })
  );
  await screen.findByText("arrived-during-load");
  await act(async () => resolveInitial(view));
  expect(screen.queryByText("before")).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
});

it("retires a client-only pending row when a post-error authoritative read confirms no admission", async () => {
  const get = vi.spyOn(api, "getHostingSnapshots").mockResolvedValue(view);
  vi.spyOn(api, "hostingSnapshotAction").mockRejectedValue(new TypeError("Network failed"));
  render(<NodeSnapshotsTab resourceId="vm" />);
  await screen.findByText("before");
  await userEvent.click(screen.getByRole("button", { name: "Create snapshot" }));
  await userEvent.type(screen.getByPlaceholderText("Snapshot name"), "not-admitted{Enter}");
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("not-admitted")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Create snapshot" })).toBeEnabled();
});

function actionInput() {
  const calls = vi.mocked(api.hostingSnapshotAction).mock.calls;
  return calls[calls.length - 1]?.[1];
}
