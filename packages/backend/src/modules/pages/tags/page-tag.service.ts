import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
export interface PageTagActivationRequest {
  id: string;
  projectId: string;
  tagId: string;
  tag: string;
  deploymentId: string;
  publicSlug: string;
  sequence: number;
  expectedGeneration: number;
  requestedById: string | null;
}
export class PageTagService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setEventBus(_eventBus: EventBusService): void {}
  async list(_projectId: string): Promise<
    {
      id: string;
      projectId: string;
      name: string;
      system: boolean;
      generation: number;
      deployment: {
        id: string;
        sequence: number;
        publicSlug: string;
        status: 'stored' | 'validating' | 'failed' | 'ready' | 'deleted' | 'uploading' | 'staging' | 'cleaning';
      } | null;
      createdAt: string;
      updatedAt: string;
    }[]
  > {
    return [];
  }
  async beginActivation(
    _projectId: string,
    _tagName: string,
    _deploymentId: string,
    _userId: string | null,
    _options?: {
      systemLatest?: boolean;
    }
  ): Promise<PageTagActivationRequest | null> {
    return commercialModuleUnavailable();
  }
  async markStaging(_activationId: string, _progress?: Record<string, unknown>): Promise<void> {
    return commercialModuleUnavailable();
  }
  async markRollingBack(_activationId: string, _progress: Record<string, unknown>): Promise<void> {
    return commercialModuleUnavailable();
  }
  async completeActivation(_request: PageTagActivationRequest): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async failActivation(_request: PageTagActivationRequest, _failureCode: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async delete(_projectId: string, _tagName: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
