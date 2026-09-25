import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type {
  StartStorageCopyJobInput,
  StorageCopyActor,
  StorageCopyJobListQuery,
  StorageCopyJobView,
} from './storage-copy.types.js';

/**
 * Server-side data copy between two S3 connections (managed or external), run by the backup runner on a
 * Storage node. The commercial backup module provides the implementation; credentials never reach the caller.
 */
export class StorageCopyService {
  async start(_input: StartStorageCopyJobInput, _actor: StorageCopyActor): Promise<StorageCopyJobView> {
    return commercialModuleUnavailable();
  }
  async get(_jobId: string, _actor: StorageCopyActor): Promise<StorageCopyJobView> {
    return commercialModuleUnavailable();
  }
  async list(_query: StorageCopyJobListQuery, _actor: StorageCopyActor): Promise<StorageCopyJobView[]> {
    return commercialModuleUnavailable();
  }
  async cancel(_jobId: string, _actor: StorageCopyActor): Promise<StorageCopyJobView> {
    return commercialModuleUnavailable();
  }
}
