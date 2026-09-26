import { Notice, NoticeAction } from "@/components/common/Notice";
import type { ObjectStorageConnection } from "@/types";
import {
  isEngineImageUnavailable,
  MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE,
  MANAGED_STORAGE_MIGRATION_DOCS_URL,
  managedStorageEngine,
} from "./managed-storage-engine";

/**
 * Shown on legacy MinIO clusters: they keep running, but new clusters use
 * SeaweedFS. The migration itself is done by the built-in assistant on
 * request; there is deliberately no migration button.
 */
export function ManagedStorageLegacyEngineBanner({
  storage,
}: {
  storage: Pick<ObjectStorageConnection, "provider" | "managed" | "lastError">;
}) {
  if (managedStorageEngine(storage) !== "minio") return null;
  const imageUnavailable =
    isEngineImageUnavailable(storage.managed?.lastError) ||
    isEngineImageUnavailable(storage.lastError);
  const writesFrozen = Boolean(storage.managed?.writesFrozenAt);

  return (
    <Notice
      role="note"
      tone="warning"
      title="Legacy MinIO engine"
      actions={
        <NoticeAction tone="warning" href={MANAGED_STORAGE_MIGRATION_DOCS_URL}>
          See the migration guide
        </NoticeAction>
      }
    >
      <div className="space-y-1.5 text-sm text-muted-foreground">
        <p>
          MinIO is no longer distributed by its vendor. This cluster keeps running; new managed
          storage clusters use SeaweedFS.
        </p>
        <p>
          To move this cluster to SeaweedFS, ask the built-in assistant to migrate it. It copies the
          data, keeps workload links and access keys working, and switches over with a short write
          pause.
        </p>
        {writesFrozen && (
          <p>
            Writes are paused for a migration: every access key and workload link of this cluster is
            read-only until the migration finishes or is rolled back.
          </p>
        )}
        {imageUnavailable && <p>{MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE}</p>}
      </div>
    </Notice>
  );
}
