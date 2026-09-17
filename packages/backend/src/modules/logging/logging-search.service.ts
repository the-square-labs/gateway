import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { LoggingClickHouseService } from './logging-clickhouse.service.js';
import type { LoggingEnvironmentService } from './logging-environment.service.js';
import type { LoggingSearchRequest } from './logging-storage.types.js';
export class LoggingSearchService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_environments: LoggingEnvironmentService, _storage: LoggingClickHouseService) {}
  async search(
    _environmentId: string,
    _query: LoggingSearchRequest
  ): Promise<{
    data: import('./logging-storage.types.js').LoggingSearchResult[];
    nextCursor: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async facets(
    _environmentId: string,
    _range?: {
      from?: string;
      to?: string;
    }
  ): Promise<import('./logging-storage.types.js').LoggingFacets> {
    return commercialModuleUnavailable();
  }
}
