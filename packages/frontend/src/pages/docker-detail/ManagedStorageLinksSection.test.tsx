import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { ManagedObjectStorage } from "@/types";
import {
  ManagedStorageLinksSection,
  type ManagedStorageLinksSectionHandle,
} from "./ManagedStorageLinksSection";

const storage: ManagedObjectStorage = {
  id: "storage-1",
  name: "Application Storage",
  slug: "application-storage",
  nodeId: "storage-node-1",
  version: "RELEASE.2026-01-01T00-00-00Z",
  storageSizeBytes: 1_073_741_824,
  publishedPort: 9000,
  sftpEnabled: false,
  sftpPort: null,
  ftpEnabled: false,
  ftpPort: null,
  ftpPassivePortStart: null,
  ftpPassivePortCount: null,
  status: "ready",
  lastError: null,
  objectStorageConnectionId: "connection-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("ManagedStorageLinksSection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stages a link and applies it against the canonical container name", async () => {
    vi.spyOn(api, "listManagedObjectStorages").mockResolvedValue([storage]);
    vi.spyOn(api, "listManagedStorageBindings").mockResolvedValue([]);
    const create = vi.spyOn(api, "createManagedStorageBinding").mockResolvedValue({
      id: "binding-1",
      clusterId: storage.id,
      targetNodeId: "node-1",
      targetType: "container",
      targetResourceId: "app",
      connectorAlias: "storage-link",
      environment: { endpoint: "S3_ENDPOINT" },
      buckets: ["uploads"],
      accessKeyId: null,
      status: "ready",
      lastError: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const ref = createRef<ManagedStorageLinksSectionHandle>();

    render(
      <ManagedStorageLinksSection
        ref={ref}
        nodeId="node-1"
        targetType="container"
        targetResourceId="app"
        containerName="app"
        canManage
      />
    );

    await screen.findByText("No managed storage links");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByPlaceholderText("assets, uploads"), {
      target: { value: "uploads" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    await screen.findByText("Application Storage");

    await act(async () => {
      await ref.current?.applyChanges({ targetEnvironment: { APP_ENV: "production" } });
    });

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(storage.id, {
        targetNodeId: "node-1",
        targetType: "container",
        targetResourceId: "app",
        environment: {
          endpoint: "S3_ENDPOINT",
          accessKeyId: "AWS_ACCESS_KEY_ID",
          secretAccessKey: "AWS_SECRET_ACCESS_KEY",
          bucket: "S3_BUCKET",
          region: "AWS_REGION",
        },
        buckets: ["uploads"],
        targetEnvironment: { APP_ENV: "production" },
      })
    );
  });

  it("removes a staged link with the ordinary environment map", async () => {
    vi.spyOn(api, "listManagedObjectStorages").mockResolvedValue([storage]);
    vi.spyOn(api, "listManagedStorageBindings").mockResolvedValue([
      {
        id: "binding-1",
        clusterId: storage.id,
        targetNodeId: "node-1",
        targetType: "container",
        targetResourceId: "app",
        connectorAlias: "storage-link",
        environment: { endpoint: "S3_ENDPOINT" },
        buckets: ["uploads"],
        accessKeyId: null,
        status: "ready",
        lastError: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const remove = vi.spyOn(api, "deleteManagedStorageBinding").mockResolvedValue();
    const ref = createRef<ManagedStorageLinksSectionHandle>();

    render(
      <ManagedStorageLinksSection
        ref={ref}
        nodeId="node-1"
        targetType="container"
        targetResourceId="app"
        containerName="app"
        canManage
      />
    );

    await screen.findByText("Application Storage");
    fireEvent.click(screen.getByTitle("Unlink storage"));
    await act(async () => {
      await ref.current?.applyChanges({ targetEnvironment: { APP_ENV: "production" } });
    });

    expect(remove).toHaveBeenCalledWith(storage.id, "binding-1", {
      targetEnvironment: { APP_ENV: "production" },
    });
  });
});
