import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DatabaseConnection, ManagedDatabase, NodeDetail } from "@/types";
import { ResizeManagedDatabaseDialog } from "./ResizeManagedDatabaseDialog";

const database = {
  id: "database-1",
  name: "Orders",
  type: "postgres",
  managed: {
    id: "managed-database-1",
    nodeId: "node-1",
    storageSizeBytes: 10 * 1024 ** 3,
    runtimeConfig: { cpuCores: 1, memoryMb: 1_024, swapMb: 0 },
    status: "ready",
  },
} as unknown as DatabaseConnection;

const node = {
  id: "node-1",
  capabilities: { cpuCores: 4 },
  lastHealthReport: {
    diskFreeBytes: 24 * 1024 ** 3,
    systemMemoryAvailableBytes: 4 * 1024 ** 3,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    diskMounts: [],
  },
} as unknown as NodeDetail;

describe("ResizeManagedDatabaseDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("only permits a larger storage size and sends a dedicated resize update", async () => {
    vi.spyOn(api, "getNode").mockResolvedValue(node);
    const update = vi
      .spyOn(api, "updateManagedDatabase")
      .mockResolvedValue({ id: database.managed!.id } as ManagedDatabase);
    const onOpenChange = vi.fn();
    const onResized = vi.fn();

    render(
      <ResizeManagedDatabaseDialog
        database={database}
        open
        onOpenChange={onOpenChange}
        onResized={onResized}
      />
    );

    await waitFor(() => expect(api.getNode).toHaveBeenCalledWith("node-1"));
    const description = screen.getByText(
      "Database storage can only be increased. This change expands the managed storage image without recreating the database."
    );
    expect(description.closest("[data-dialog-body]")).toBeInTheDocument();
    expect(description.closest("[data-dialog-header]")).not.toBeInTheDocument();

    const input = screen.getByLabelText("New storage size, GB");
    const resize = screen.getByRole("button", { name: "Resize database" });

    fireEvent.change(input, { target: { value: "10" } });
    expect(resize).toBeDisabled();

    fireEvent.change(input, { target: { value: "34" } });
    expect(resize).toBeEnabled();
    fireEvent.click(resize);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("managed-database-1", { storageSizeGb: 34 })
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onResized).toHaveBeenCalledTimes(1);
  });
});
