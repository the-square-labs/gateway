import { describe, expect, it } from "vitest";
import type { ObjectStorageConnection } from "@/types";
import { isManagedStorageFull } from "./managed-storage-engine";

type Managed = NonNullable<ObjectStorageConnection["managed"]>;

const managed = (status: Managed["status"], lastError: string | null) => ({
  managed: { status, lastError } as Managed,
});

describe("managed storage with a full disk", () => {
  it("is full while the serving cluster reports it", () => {
    expect(
      isManagedStorageFull(
        managed("ready", "MANAGED_STORAGE_FULL: The storage disk is full, so uploads are refused.")
      )
    ).toBe(true);
  });

  it("is not full otherwise", () => {
    expect(isManagedStorageFull(managed("ready", null))).toBe(false);
    expect(isManagedStorageFull(managed("ready", "Published port 9000 is reserved"))).toBe(false);
    expect(
      isManagedStorageFull(managed("updating", "MANAGED_STORAGE_FULL: The storage disk is full"))
    ).toBe(false);
    expect(isManagedStorageFull({ managed: undefined })).toBe(false);
  });
});
