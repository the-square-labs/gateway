import { Notice } from "@/components/common/Notice";
import type { ObjectStorageConnection } from "@/types";
import { isManagedStorageFull } from "./managed-storage-engine";

/**
 * Shown while a managed cluster's disk is full: it still serves reads but
 * refuses uploads. The space of deleted objects comes back on its own.
 */
export function ManagedStorageFullNotice({
  storage,
}: {
  storage: Pick<ObjectStorageConnection, "managed">;
}) {
  if (!isManagedStorageFull(storage)) return null;
  return (
    <Notice role="status" tone="destructive" title="Storage is full">
      Uploads are refused until there is room again. Grow the storage in its settings or delete
      objects; the space of deleted objects is given back automatically within minutes.
    </Notice>
  );
}
