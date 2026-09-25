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
    <div
      role="note"
      className="space-y-1.5 border border-warning bg-warning/10 p-3 text-sm text-warning-foreground"
    >
      <p>
        <span className="font-medium">Legacy MinIO engine.</span> MinIO is no longer distributed by
        its vendor. This cluster keeps running; new managed storage clusters use SeaweedFS.
      </p>
      <p>
        To move this cluster to SeaweedFS, ask the built-in assistant to migrate it. It copies the
        data, keeps workload links and access keys working, and switches over with a short write
        pause.{" "}
        <a
          href={MANAGED_STORAGE_MIGRATION_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[color:var(--color-link)] hover:underline"
        >
          See the migration guide
        </a>
      </p>
      {writesFrozen && (
        <p>
          Writes are paused for a migration: every access key and workload link of this cluster is
          read-only until the migration finishes or is rolled back.
        </p>
      )}
      {imageUnavailable && <p>{MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE}</p>}
    </div>
  );
}
