import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { PageTagActivationRequest, PageTagService } from './page-tag.service.js';
export interface PageTagPublicationAdapter {
  stage(request: PageTagActivationRequest): Promise<Record<string, unknown>>;
  rollback?(request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void>;
}
export interface PageDeploymentPublicationAdapter {
  publish(deploymentId: string): Promise<void>;
}
export class PagePublicationService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService, _tagService: PageTagService) {}
  setEventBus(_eventBus: EventBusService): void {}
  setAdapter(_adapter: PageTagPublicationAdapter): void {
    commercialModuleUnavailable();
  }
  setDeploymentAdapter(_adapter: PageDeploymentPublicationAdapter): void {
    commercialModuleUnavailable();
  }
  async moveUserTag(
    _projectId: string,
    _tag: string,
    _deploymentId: string,
    _userId: string
  ): Promise<
    | {
        changed: boolean;
        activationId?: undefined;
        generation?: undefined;
      }
    | {
        changed: boolean;
        activationId: string;
        generation: number;
      }
  > {
    return commercialModuleUnavailable();
  }
  async markDeploymentReady(_deploymentId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
