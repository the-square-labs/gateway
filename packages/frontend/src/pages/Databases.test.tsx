import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { DatabaseConnection, ManagedDatabaseCreateInput, Node } from "@/types";
import {
  applyDatabaseHealthSample,
  canRenderDatabaseRowsWithNodeAppearance,
  ManagedDatabaseCreateForm,
} from "./Databases";
import type { ManagedDatabaseCapacity } from "./database-detail/managed-database-capacity";

const database = (overrides: Partial<DatabaseConnection> = {}) =>
  ({
    id: "db-1",
    name: "Primary",
    type: "postgres",
    healthStatus: "unknown",
    lastHealthCheckAt: null,
    ...overrides,
  }) as DatabaseConnection;

describe("database list state", () => {
  it("applies health samples in place without replacing unrelated rows", () => {
    const untouched = database({ id: "db-2", name: "Replica" });
    const rows = [database(), untouched];

    const next = applyDatabaseHealthSample(rows, {
      id: "db-1",
      action: "health.sampled",
      healthStatus: "online",
      sampledAt: "2026-08-14T12:00:00.000Z",
    });

    expect(next[0]).toMatchObject({
      healthStatus: "online",
      lastHealthCheckAt: "2026-08-14T12:00:00.000Z",
    });
    expect(next[1]).toBe(untouched);
  });

  it("waits for the managed node appearance before rendering cached rows", () => {
    const rows = [
      database({
        managed: { nodeId: "node-1" } as DatabaseConnection["managed"],
      }),
    ];

    expect(canRenderDatabaseRowsWithNodeAppearance(rows, [])).toBe(false);
    expect(canRenderDatabaseRowsWithNodeAppearance(rows, [{ id: "node-1" } as Node])).toBe(true);
    expect(canRenderDatabaseRowsWithNodeAppearance([database()], [])).toBe(true);
  });

  it("keeps tag separators while editing more than one managed database tag", () => {
    function Harness() {
      const [draft, setDraft] = useState<ManagedDatabaseCreateInput>({
        name: "Test database",
        type: "postgres",
        version: "17",
        nodeId: "node-1",
        storageSizeGb: 10,
        cpuCores: 1,
        memoryMb: 1024,
        swapMb: 0,
        tags: [],
        publishTcp: false,
        tlsEnabled: true,
      });

      return (
        <ManagedDatabaseCreateForm
          draft={draft}
          nodes={[]}
          catalog={[]}
          capacity={{} as ManagedDatabaseCapacity}
          step={1}
          onChange={setDraft}
        />
      );
    }

    render(<Harness />);
    const input = screen.getByLabelText("Tags");

    fireEvent.change(input, { target: { value: "team, " } });
    expect(input).toHaveValue("team, ");

    fireEvent.change(input, { target: { value: "team, green:production" } });
    expect(input).toHaveValue("team, green:production");
  });
});
