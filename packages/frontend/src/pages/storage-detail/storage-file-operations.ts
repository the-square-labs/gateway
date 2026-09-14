import { formatDate } from "@/lib/utils";
import type { FileManagerOperations } from "@/pages/docker-detail/FilesTab";
import { api } from "@/services/api";
import type { FileEntry } from "@/types";

export function storageFileOperations(
  storageId: string,
  bucket: string,
  canWrite: boolean
): FileManagerOperations {
  const directories = new Set<string>();
  const keyFor = (path: string) => path.replace(/^\//, "");
  const list = async (prefix: string, delimiter = "/") => {
    const objects = [];
    const prefixes = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const page = await api.listObjects(storageId, {
        bucket,
        prefix,
        delimiter,
        continuationToken,
        maxKeys: 1000,
      });
      objects.push(...page.objects);
      page.prefixes.forEach((entry) => prefixes.add(entry));
      continuationToken = page.isTruncated ? (page.nextContinuationToken ?? undefined) : undefined;
    } while (continuationToken);
    return { objects, prefixes: [...prefixes] };
  };
  return {
    listDirectory: async (path) => {
      const prefix = path === "/" ? "" : `${keyFor(path)}/`;
      const result = await list(prefix);
      const entries: FileEntry[] = result.prefixes.map((directory) => {
        const key = directory.replace(/\/$/, "");
        directories.add(`/${key}`);
        return {
          name: key.slice(prefix.length),
          size: 0,
          permissions: "—",
          isDir: true,
          modified: "",
          isWritable: canWrite,
        };
      });
      for (const object of result.objects) {
        if (object.key === prefix) continue;
        entries.push({
          name: object.key.slice(prefix.length),
          size: object.size,
          permissions: "—",
          isDir: false,
          modified: object.lastModified ? formatDate(object.lastModified) : "—",
          isWritable: canWrite,
        });
      }
      return entries;
    },
    readFile: (path) => api.readObject(storageId, bucket, keyFor(path)),
    openFile: (path, writable) => {
      const params = new URLSearchParams({ bucket, path });
      if (canWrite && writable) params.set("writable", "1");
      window.open(
        `/storage/file/${encodeURIComponent(storageId)}?${params}`,
        `storage-file-${storageId}-${path}`,
        "width=900,height=600,menubar=no,toolbar=no"
      );
    },
    ...(canWrite
      ? ({
          createFile: (path, content, onProgress) => {
            const body = content instanceof Blob ? content : new Blob([content as BlobPart]);
            return api.uploadObject(
              storageId,
              {
                bucket,
                key: keyFor(path),
                contentType: body.type || "application/octet-stream",
                body,
              },
              onProgress
            );
          },
          createDirectory: (path) => api.createPrefix(storageId, bucket, `${keyFor(path)}/`),
          deletePath: async (path) => {
            const key = keyFor(path);
            const keys = directories.has(path)
              ? [
                  ...new Set([
                    ...(await list(`${key}/`, "")).objects.map((object) => object.key),
                    `${key}/`,
                  ]),
                ]
              : [key];
            for (let offset = 0; offset < keys.length; offset += 1000) {
              await api.deleteObjects(storageId, bucket, keys.slice(offset, offset + 1000));
            }
          },
        } satisfies Partial<FileManagerOperations>)
      : {}),
  };
}
