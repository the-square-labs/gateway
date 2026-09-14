import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { storageFileOperations } from "./storage-file-operations";

vi.mock("@/services/api", () => ({
  api: { listObjects: vi.fn(), deleteObjects: vi.fn(), readObject: vi.fn() },
}));
describe("storage file manager adapter", () => {
  beforeEach(() => vi.clearAllMocks());
  it("loads all listing pages and maps folders into the shared tree", async () => {
    vi.mocked(api.listObjects)
      .mockResolvedValueOnce({
        prefixes: ["docs/"],
        objects: [],
        isTruncated: true,
        nextContinuationToken: "next",
      } as never)
      .mockResolvedValueOnce({
        prefixes: [],
        objects: [{ key: "file.txt", size: 3, lastModified: null }],
        isTruncated: false,
      } as never);
    const ops = storageFileOperations("storage", "bucket", true);
    const entries = await ops.listDirectory!("/");
    expect(entries.map((entry) => [entry.name, entry.isDir])).toEqual([
      ["docs", true],
      ["file.txt", false],
    ]);
    expect(api.listObjects).toHaveBeenLastCalledWith(
      "storage",
      expect.objectContaining({ bucket: "bucket", continuationToken: "next" })
    );
  });
  it("deletes a folder only through its slash-delimited prefix", async () => {
    vi.mocked(api.listObjects)
      .mockResolvedValueOnce({ prefixes: ["docs/"], objects: [], isTruncated: false } as never)
      .mockResolvedValueOnce({
        prefixes: [],
        objects: [{ key: "docs/a.txt" }],
        isTruncated: false,
      } as never);
    const ops = storageFileOperations("storage", "bucket", true);
    await ops.listDirectory!("/");
    await ops.deletePath!("/docs");
    expect(api.listObjects).toHaveBeenLastCalledWith(
      "storage",
      expect.objectContaining({ prefix: "docs/", delimiter: "" })
    );
    expect(api.deleteObjects).toHaveBeenCalledWith("storage", "bucket", ["docs/a.txt", "docs/"]);
  });
  it("does not expose mutation operations for read-only access", () => {
    const ops = storageFileOperations("storage", "bucket", false);
    expect(ops.createFile).toBeUndefined();
    expect(ops.deletePath).toBeUndefined();
    expect(ops.movePath).toBeUndefined();
  });
});
