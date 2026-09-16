import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ManagedObjectStorage } from "@/types";
import { ManagedStorageLinkDialog } from "./ManagedStorageLinkDialog";

describe("managed storage link form", () => {
  it("uses the same input and label typography throughout, with a full-width Region", () => {
    render(
      <ManagedStorageLinkDialog
        open
        onOpenChange={() => {}}
        clusters={[]}
        containerName="app"
        onStage={() => {}}
      />
    );
    const buckets = screen.getByPlaceholderText("assets, uploads");
    const labelClass = buckets.closest("label")?.querySelector("span")?.className;
    for (const label of ["Endpoint", "Access key", "Secret key", "Bucket", "Region"]) {
      const input = screen.getByRole("textbox", { name: label });
      expect(input.className).toBe(buckets.className);
      expect(input.closest("label")?.querySelector("span")?.className).toBe(labelClass);
    }
    expect(screen.getByRole("textbox", { name: "Region" }).closest("label")).toHaveClass(
      "md:col-span-2"
    );
  });

  it("preserves staging and secret name validation", () => {
    const stage = vi.fn();
    render(
      <ManagedStorageLinkDialog
        open
        onOpenChange={() => {}}
        clusters={[{ id: "s1", name: "Storage" } as ManagedObjectStorage]}
        containerName="app"
        onStage={stage}
      />
    );
    fireEvent.change(screen.getByPlaceholderText("assets, uploads"), {
      target: { value: "assets, uploads" },
    });
    const region = screen.getByRole("textbox", { name: "Region" });
    fireEvent.change(region, { target: { value: "S3_ENDPOINT" } });
    expect(screen.getByRole("button", { name: "Add link" })).toBeDisabled();
    fireEvent.change(region, { target: { value: "CUSTOM_REGION" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(stage).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterId: "s1",
        buckets: ["assets", "uploads"],
        environment: expect.objectContaining({ region: "CUSTOM_REGION" }),
      })
    );
  });
});
