import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConfirmDialog } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import { ManagedDatabaseSettingsTab } from "./ManagedDatabaseSettingsTab";

const database = {
  id: "database-1",
  name: "Orders",
  type: "postgres",
  tags: ["green:production", "orders"],
  managed: {
    id: "managed-database-1",
    nodeId: "node-1",
    version: "17.5",
    storageSizeBytes: 1024 ** 3,
    runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 256 },
    publishedPort: null,
    endpointHost: null,
    status: "ready",
    lastError: null,
  },
} as unknown as DatabaseConnection;

describe("ManagedDatabaseSettingsTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useConfirmDialog.getState().close();
  });

  it("groups tags with the name and makes TCP publication an explicit recreate action", async () => {
    const user = userEvent.setup();
    render(<ManagedDatabaseSettingsTab database={database} onSaved={() => undefined} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Orders");
    expect(screen.getByLabelText("Tags")).toHaveValue("green:production, orders");
    expect(screen.getByLabelText("CPU cores")).toBeInTheDocument();
    expect(screen.getByLabelText("Memory, MB")).toBeInTheDocument();
    expect(screen.getByLabelText("Swap, MB")).toBeInTheDocument();
    expect(screen.getByText("Publish TCP port")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Publish TCP port" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Published TCP port")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Leave empty to let Docker allocate a free port. Changing publication recreates only the database container; its storage is retained."
        )
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save & Recreate" })).toBeInTheDocument();
    });
  });

  it("keeps the recreate action visibly pending until the daemon confirms readiness", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "updateManagedDatabase").mockReturnValue(new Promise<never>(() => undefined));
    render(<ManagedDatabaseSettingsTab database={database} onSaved={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Publish TCP port" }));
    await user.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await act(async () => {
      useConfirmDialog.getState().onConfirm?.();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Recreating database..." })).toBeDisabled()
    );
  });

  it("requires confirmation and explains the expected database downtime before recreate", async () => {
    const user = userEvent.setup();
    const update = vi
      .spyOn(api, "updateManagedDatabase")
      .mockResolvedValue({ id: database.managed!.id } as never);
    render(<ManagedDatabaseSettingsTab database={database} onSaved={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "Publish TCP port" }));
    await user.click(screen.getByRole("button", { name: "Save & Recreate" }));

    expect(useConfirmDialog.getState()).toMatchObject({
      open: true,
      title: "Save & Recreate",
      confirmLabel: "Recreate",
      description:
        "Recreating this database will temporarily take it offline. It usually takes about 15 seconds while the database starts and passes its readiness check. Continue?",
    });
    expect(update).not.toHaveBeenCalled();

    act(() => useConfirmDialog.getState().onConfirm?.());
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("locks managed database settings while the database is paused", () => {
    render(
      <ManagedDatabaseSettingsTab
        database={{ ...database, managed: { ...database.managed!, status: "paused" } }}
        onSaved={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish TCP port" })).toBeDisabled();
  });

  it("lets ClickHouse publish HTTP without publishing its native TCP endpoint", async () => {
    const user = userEvent.setup();
    render(
      <ManagedDatabaseSettingsTab
        database={{
          ...database,
          type: "clickhouse",
          managed: { ...database.managed!, publishedPort: 8443, publishedNativePort: 9440 },
        }}
        onSaved={() => undefined}
      />
    );

    expect(screen.getByLabelText("Native TCP port")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish native TCP port" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Native TCP port")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save & Recreate" })).toBeInTheDocument();
    });
  });
});
