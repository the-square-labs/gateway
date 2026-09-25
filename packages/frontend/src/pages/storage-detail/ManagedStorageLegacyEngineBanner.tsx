import type { ObjectStorageConnection } from "@/types";
import {
  isEngineImageUnavailable,
  MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE,
  MANAGED_STORAGE_MIGRATION_DOCS_URL,
  managedStorageEngine,
} from "./managed-storage-engine";

/** Shown on legacy MinIO clusters: they keep running, but new clusters use SeaweedFS. */
export function ManagedStorageLegacyEngineBanner({
  storage,
}: {
  storage: Pick<ObjectStorageConnection, "provider" | "managed" | "lastError">;
}) {
  if (managedStorageEngine(storage) !== "minio") return null;
  const imageUnavailable =
    isEngineImageUnavailable(storage.managed?.lastError) ||
    isEngineImageUnavailable(storage.lastError);

  return (
    <div
      role="note"
      className="space-y-1.5 border border-warning bg-warning/10 p-3 text-sm text-warning-foreground"
    >
      <p>
        <span className="font-medium">Legacy MinIO engine.</span> MinIO is no longer distributed by
        its vendor. This cluster keeps running; new managed storage clusters use SeaweedFS.{" "}
        <a
          href={MANAGED_STORAGE_MIGRATION_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[color:var(--color-link)] hover:underline"
        >
          See the migration guide
        </a>
      </p>
      {imageUnavailable && <p>{MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE_MESSAGE}</p>}
    </div>
  );
}
