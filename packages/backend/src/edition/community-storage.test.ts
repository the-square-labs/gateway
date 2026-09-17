import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectStorageService } from '@/modules/object-storage/object-storage.service.js';
import { ObjectStorageMonitoringService } from '@/modules/object-storage/object-storage-monitoring.service.js';
import { ObjectStorageUploadService } from '@/modules/object-storage/object-storage-upload.service.js';
import { storageCommercialRuntime } from '@/modules/object-storage/storage-commercial-runtime.js';
import { CommercialEditionRuntime } from './runtime.js';

afterEach(() => vi.useRealTimers());

describe('Community storage absence', () => {
  it('does not start polling or spool cleanup and rejects storage operations', async () => {
    vi.useFakeTimers();
    const edition = CommercialEditionRuntime.community();
    const db = { query: { objectStorageConnections: { findFirst: vi.fn() } } };
    const storage = edition.createObjectStorageService(
      ObjectStorageService,
      [db as never, {} as never, {} as never],
      storageCommercialRuntime
    );
    const monitoring = edition.createStorageMonitoring(
      ObjectStorageMonitoringService,
      [storage, null],
      storageCommercialRuntime
    );
    const uploads = edition.createStorageUploads(
      ObjectStorageUploadService,
      [storage, {} as never],
      storageCommercialRuntime
    );
    expect(vi.getTimerCount()).toBe(0);
    await expect(storage.revealCredentials('storage')).rejects.toMatchObject({ code: 'COMMERCIAL_MODULE_UNAVAILABLE' });
    await expect(uploads.execute({ id: 'user', scopes: [] }, {})).rejects.toMatchObject({
      code: 'COMMERCIAL_MODULE_UNAVAILABLE',
    });
    await expect(monitoring.getHistory('storage')).rejects.toMatchObject({ code: 'COMMERCIAL_MODULE_UNAVAILABLE' });
    expect(db.query.objectStorageConnections.findFirst).not.toHaveBeenCalled();
    monitoring.destroy();
    storage.shutdown();
    await uploads.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
