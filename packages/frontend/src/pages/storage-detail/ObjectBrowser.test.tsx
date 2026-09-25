import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { ObjectStorageConnection } from "@/types";
import { ObjectBrowser } from "./ObjectBrowser";

vi.mock("../docker-detail/FilesTab", () => ({
  FilesTab: ({ headerActions }: { headerActions: ReactNode }) => <div>{headerActions}</div>,
}));

const storage = {
  id: "s1",
  name: "App Storage",
  provider: "minio",
  defaultBucket: null,
} as unknown as ObjectStorageConnection;

afterEach(() => vi.restoreAllMocks());

describe("ObjectBrowser bucket creation", () => {
  it("hides bucket creation from object writers without bucket admin, like the API", async () => {
    vi.spyOn(api, "listBuckets").mockResolvedValue([]);
    const view = render(<ObjectBrowser storage={storage} canWrite canCreateBuckets={false} />);
    expect(await screen.findByText("No buckets yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create bucket" })).not.toBeInTheDocument();
    view.unmount();

    vi.mocked(api.listBuckets).mockResolvedValue([{ name: "assets" }] as never);
    render(<ObjectBrowser storage={storage} canWrite canCreateBuckets={false} />);
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New bucket" })).not.toBeInTheDocument();
  });

  it("offers bucket creation with storage:objects:admin", async () => {
    vi.spyOn(api, "listBuckets").mockResolvedValue([]);
    const view = render(<ObjectBrowser storage={storage} canWrite={false} canCreateBuckets />);
    expect(await screen.findByRole("button", { name: "Create bucket" })).toBeInTheDocument();
    view.unmount();

    vi.mocked(api.listBuckets).mockResolvedValue([{ name: "assets" }] as never);
    render(<ObjectBrowser storage={storage} canWrite canCreateBuckets />);
    expect(await screen.findByRole("button", { name: "New bucket" })).toBeInTheDocument();
  });
});
