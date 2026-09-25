import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/services/api-base";
import type { ObjectStorageConnection } from "@/types";
import {
  catalogEngineVersions,
  formatManagedStorageError,
  isEngineImageUnavailable,
  MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE,
  managedStorageEngine,
  managedStorageErrorMessage,
  managedStorageMinimumMemoryMb,
} from "./managed-storage-engine";

const managed = {} as NonNullable<ObjectStorageConnection["managed"]>;

describe("managed storage engine", () => {
  it("treats a managed view without an engine as MinIO and external connections as engine-less", () => {
    expect(managedStorageEngine({ provider: "minio", managed })).toBe("minio");
    expect(managedStorageEngine({ provider: "seaweedfs", managed })).toBe("seaweedfs");
    expect(
      managedStorageEngine({ provider: "minio", managed: { ...managed, engine: "seaweedfs" } })
    ).toBe("seaweedfs");
    expect(managedStorageEngine({ provider: "minio" })).toBeNull();
  });

  it("reads versions of one engine from the catalog and sets engine memory minimums", () => {
    const catalog = [
      { type: "minio" as const, versions: ["2025-04-22"] },
      { type: "seaweedfs" as const, versions: ["4.47"] },
    ];
    expect(catalogEngineVersions(catalog, "seaweedfs")).toEqual(["4.47"]);
    expect(catalogEngineVersions([], "seaweedfs")).toEqual([]);
    expect(managedStorageMinimumMemoryMb("seaweedfs")).toBe(512);
    expect(managedStorageMinimumMemoryMb("minio")).toBe(256);
  });

  it("recognises the typed engine-image error from the API and from stored messages", () => {
    const typed = new ApiRequestError("pull quay.io/minio/minio: denied", {
      status: 409,
      code: "MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE",
    });
    expect(isEngineImageUnavailable(typed)).toBe(true);
    expect(managedStorageErrorMessage(typed, "Failed")).toBe(
      MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE
    );
    expect(isEngineImageUnavailable("managed storage engine image unavailable: minio")).toBe(true);
    expect(isEngineImageUnavailable(null)).toBe(false);

    const other = new ApiRequestError("Port 9000 is already used", {
      status: 409,
      code: "MANAGED_STORAGE_PORT_CONFLICT",
    });
    expect(managedStorageErrorMessage(other, "Failed")).toBe("Port 9000 is already used");
    expect(managedStorageErrorMessage("boom", "Failed")).toBe("Failed");
    expect(formatManagedStorageError("disk full")).toBe("disk full");
  });
});
