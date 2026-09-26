import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ObjectStorageConnection } from "@/types";
import { ManagedStorageLegacyEngineBanner } from "./ManagedStorageLegacyEngineBanner";

type BannerStorage = Pick<ObjectStorageConnection, "provider" | "managed" | "lastError">;

function managed(overrides: Partial<NonNullable<ObjectStorageConnection["managed"]>> = {}) {
  return {
    id: "cluster-1",
    nodeId: "node-1",
    version: "2025-04-22",
    storageSizeBytes: 1024,
    runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
    publishedPort: 9000,
    status: "ready",
    lastError: null,
    ...overrides,
  } as NonNullable<ObjectStorageConnection["managed"]>;
}

function renderBanner(storage: BannerStorage) {
  return render(<ManagedStorageLegacyEngineBanner storage={storage} />);
}

describe("legacy MinIO engine banner", () => {
  it("marks a managed cluster without an engine as legacy MinIO and links the migration guide", () => {
    renderBanner({ provider: "minio", managed: managed(), lastError: null });
    const banner = screen.getByRole("note");
    expect(within(banner).getByText("Legacy MinIO engine")).toBeInTheDocument();
    expect(banner).toHaveTextContent(
      "MinIO is no longer distributed by its vendor. This cluster keeps running; new managed storage clusters use SeaweedFS."
    );
    expect(within(banner).getByRole("link", { name: "See the migration guide" })).toHaveAttribute(
      "href",
      "https://docs.goodgateway.dev/en/storage/overview/#migrating-from-minio"
    );
    expect(banner).not.toHaveTextContent("can no longer be downloaded");
  });

  it("points to the built-in assistant for the migration without offering a migration button", () => {
    renderBanner({ provider: "minio", managed: managed(), lastError: null });
    const banner = screen.getByRole("note");
    expect(banner).toHaveTextContent(
      "To move this cluster to SeaweedFS, ask the built-in assistant to migrate it."
    );
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(banner).not.toHaveTextContent("Writes are paused");
  });

  it("says when writes are frozen for a migration", () => {
    renderBanner({
      provider: "minio",
      managed: managed({ writesFrozenAt: "2026-09-25T10:00:00.000Z" }),
      lastError: null,
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Writes are paused for a migration: every access key and workload link of this cluster is read-only"
    );
  });

  it("stays hidden for SeaweedFS clusters and external connections", () => {
    const { container, rerender } = renderBanner({
      provider: "seaweedfs",
      managed: managed({ engine: "seaweedfs", version: "4.47" }),
      lastError: null,
    });
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ManagedStorageLegacyEngineBanner
        storage={{ provider: "seaweedfs", managed: managed({ version: "4.47" }), lastError: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ManagedStorageLegacyEngineBanner
        storage={{ provider: "minio", managed: undefined, lastError: null }}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains a failed operation whose engine image is no longer available", () => {
    renderBanner({
      provider: "minio",
      managed: managed({
        engine: "minio",
        status: "error",
        lastError: "MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE: quay.io/minio/minio is not cached",
      }),
      lastError: null,
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "The MinIO image for this legacy cluster is no longer on the node and can no longer be downloaded"
    );
  });
});
