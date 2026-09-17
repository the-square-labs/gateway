import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { SavePageRuntimeConfigInput } from './page-runtime-config.schemas.js';
export interface PageRuntimeConfigPublicationRequest {
  projectId: string;
  tagId: string | null;
  value: Record<string, unknown>;
  sourceGeneration: number;
  action: 'save' | 'reset';
}
export interface PageRuntimeConfigPublicationAdapter {
  publishRuntimeConfig(request: PageRuntimeConfigPublicationRequest): Promise<void>;
}
export class PageRuntimeConfigService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setEventBus(_eventBus: EventBusService): void {}
  setPublicationAdapter(_adapter: PageRuntimeConfigPublicationAdapter): void {}
  async list(_projectId: string): Promise<{
    default: {
      id: string;
      projectId: string;
      tagId: string | null;
      value: import('@/db/schema/index.js').PageRuntimeConfigValue;
      source: string;
      generation: number;
      updatedById: string | null;
      updatedAt: string;
    };
    overrides: {
      id: string;
      projectId: string;
      tagId: string | null;
      value: import('@/db/schema/index.js').PageRuntimeConfigValue;
      source: string;
      generation: number;
      updatedById: string | null;
      updatedAt: string;
    }[];
    tags: {
      hasOverride: boolean;
      inherited: boolean;
      override: {
        id: string;
        projectId: string;
        tagId: string | null;
        value: import('@/db/schema/index.js').PageRuntimeConfigValue;
        source: string;
        generation: number;
        updatedById: string | null;
        updatedAt: string;
      } | null;
      effective: {
        id: string;
        projectId: string;
        tagId: string | null;
        value: import('@/db/schema/index.js').PageRuntimeConfigValue;
        source: string;
        generation: number;
        updatedById: string | null;
        updatedAt: string;
      };
      id: string;
      name: string;
      system: boolean;
    }[];
  }> {
    return commercialModuleUnavailable();
  }
  async getEffective(
    _projectId: string,
    _tagId: string | null
  ): Promise<{
    inherited: boolean;
    id: string;
    projectId: string;
    tagId: string | null;
    value: import('@/db/schema/index.js').PageRuntimeConfigValue;
    source: string;
    generation: number;
    updatedById: string | null;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async saveDefault(
    _projectId: string,
    _input: SavePageRuntimeConfigInput,
    _userId: string
  ): Promise<{
    inherited: boolean;
    id: string;
    projectId: string;
    tagId: string | null;
    value: import('@/db/schema/index.js').PageRuntimeConfigValue;
    source: string;
    generation: number;
    updatedById: string | null;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async saveTag(
    _projectId: string,
    _tagId: string,
    _input: SavePageRuntimeConfigInput,
    _userId: string
  ): Promise<{
    inherited: boolean;
    id: string;
    projectId: string;
    tagId: string | null;
    value: import('@/db/schema/index.js').PageRuntimeConfigValue;
    source: string;
    generation: number;
    updatedById: string | null;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
  async resetTag(
    _projectId: string,
    _tagId: string,
    _expectedGeneration: number,
    _userId: string
  ): Promise<{
    inherited: boolean;
    id: string;
    projectId: string;
    tagId: string | null;
    value: import('@/db/schema/index.js').PageRuntimeConfigValue;
    source: string;
    generation: number;
    updatedById: string | null;
    updatedAt: string;
  }> {
    return commercialModuleUnavailable();
  }
}
