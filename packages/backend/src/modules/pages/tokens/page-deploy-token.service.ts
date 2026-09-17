import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { CreatePageDeployTokenInput } from './page-deploy-token.schemas.js';
export interface ValidatedPageDeployToken {
  tokenId: string;
  tokenPrefix: string;
  projectId: string;
  allowedTagPatterns: string[];
  allowUserTag: boolean;
}
export class PageDeployTokenService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(_db: DrizzleClient, _auditService: AuditService) {}
  setEventBus(_eventBus: EventBusService): void {}
  async list(_projectId: string): Promise<
    {
      id: string;
      projectId: string;
      name: string;
      tokenPrefix: string;
      allowedTagPatterns: string[];
      allowUserTag: boolean;
      lastUsedAt: string | null;
      expiresAt: string | null;
      revokedAt: string | null;
      createdAt: string;
    }[]
  > {
    return [];
  }
  async create(
    _projectId: string,
    _input: CreatePageDeployTokenInput,
    _userId: string
  ): Promise<{
    id: string;
    projectId: string;
    name: string;
    tokenPrefix: string;
    allowedTagPatterns: string[];
    allowUserTag: boolean;
    expiresAt: string | null;
    createdAt: string;
    token: string;
  }> {
    return commercialModuleUnavailable();
  }
  async revoke(_projectId: string, _tokenId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async validate(_raw: string): Promise<ValidatedPageDeployToken | null> {
    return null;
  }
  assertTagAllowed(_token: ValidatedPageDeployToken, _tag: string | null | undefined): void {
    commercialModuleUnavailable();
  }
}
