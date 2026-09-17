import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { GeneralSettingsService } from '@/modules/settings/general-settings.service.js';
import type { User } from '@/types.js';
import type { ObjectStorageService } from './object-storage.service.js';
export const STORAGE_UPLOAD_CHUNK_BYTES = 1048576;
type State = 'open' | 'finalizing' | 'completed' | 'failed' | 'aborted';
/** MCP carries bounded chunks; only the private spool file reaches provider streaming. */
export class ObjectStorageUploadService {
  // biome-ignore lint/complexity/noUselessConstructor: Stable private service constructor contract.
  constructor(
    _storage: Pick<ObjectStorageService, 'get' | 'uploadObject'>,
    _settings: Pick<GeneralSettingsService, 'getConfig'>,
    _temporaryRoot?: string
  ) {}
  async execute(
    _user: Pick<User, 'id' | 'scopes'>,
    _args: Record<string, unknown>
  ): Promise<{
    uploadId: string;
    storageId: string;
    bucket: string;
    key: string;
    offset: number;
    declaredSizeBytes: number;
    status: State;
    expiresAt: string;
    maxChunkBytes: number;
  }> {
    return commercialModuleUnavailable();
  }
  async cleanup(): Promise<void> {}
  async destroy(): Promise<void> {}
}
