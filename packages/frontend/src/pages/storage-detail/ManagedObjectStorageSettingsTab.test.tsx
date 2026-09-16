import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { ObjectStorageConnection } from "@/types";
import { ManagedObjectStorageSettingsTab } from "./ManagedObjectStorageSettingsTab";

const storage = {
  id: "connection-1",
  name: "App Storage",
  tags: [],
  managed: {
    id: "storage-1",
    publishS3: false,
    publishedPort: 9000,
    runtimeConfig: { cpuCores: 2, memoryMb: 2048, swapMb: 0 },
  },
} as unknown as ObjectStorageConnection;

afterEach(() => vi.restoreAllMocks());

describe("managed storage settings", () => {
  it("uses the shared toggle block and resets the publication state with saved data", () => {
    const view = render(<ManagedObjectStorageSettingsTab storage={storage} onSaved={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Publish S3 endpoint" });
    expect(toggle.parentElement).toHaveClass("border", "bg-muted/30", "p-3");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    view.rerender(
      <ManagedObjectStorageSettingsTab
        storage={{ ...storage, managed: { ...storage.managed!, publishS3: true } }}
        onSaved={() => {}}
      />
    );
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("saves the selected publication state through the existing update API", async () => {
    const update = vi.spyOn(api, "updateManagedObjectStorage").mockResolvedValue({} as never);
    render(<ManagedObjectStorageSettingsTab storage={storage} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish S3 endpoint" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(update).toHaveBeenCalledWith(
      "storage-1",
      expect.objectContaining({ publishS3: true, publishedPort: 9000 })
    );
    await screen.findByRole("button", { name: "Save Changes" });
  });
});
