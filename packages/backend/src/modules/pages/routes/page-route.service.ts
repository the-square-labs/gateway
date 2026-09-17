import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { CreateProxyHostInput } from '@/modules/proxy/proxy.schemas.js';
import type { PageNodeRuntimeService } from '../runtime/page-node-runtime.service.js';
import type {
  PageRuntimeConfigPublicationRequest,
  PageRuntimeConfigService,
} from '../runtime-config/page-runtime-config.service.js';
import type { PageTagActivationRequest } from '../tags/page-tag.service.js';
export interface AdditionalPageRoutePublicationAdapter {
  stageTagPublication(request: PageTagActivationRequest): Promise<Record<string, unknown>>;
  rollbackTagPublication?(request: PageTagActivationRequest, progress: Record<string, unknown>): Promise<void>;
  publishRuntimeConfig?(request: PageRuntimeConfigPublicationRequest): Promise<Record<string, unknown>>;
  rollbackRuntimeConfig?(
    request: PageRuntimeConfigPublicationRequest,
    progress: Record<string, unknown>
  ): Promise<void>;
}
export interface PageRouteNodeMigration {
  routeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  deploymentId: string;
  previousIncludePath: string | null;
  targetIncludePath: string;
  generation: number;
}
export class PageRouteService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _runtime: PageNodeRuntimeService,
    _auditService: AuditService,
    _runtimeConfig: PageRuntimeConfigService
  ) {}
  setAdditionalRoutePublicationAdapter(_adapter: AdditionalPageRoutePublicationAdapter): void {}
  async validateCreate(_input: CreateProxyHostInput): Promise<{
    projectId: string;
    tagId: string;
  }> {
    return commercialModuleUnavailable();
  }
  async activateNewHost(_proxyHostId: string, _nodeId: string, _projectId: string, _tagId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getRenderConfig(_proxyHostId: string): Promise<{
    includePath: string;
    spaFallback: boolean;
    fallbackUrl: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async getIncludePath(_proxyHostId: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  async getTarget(_proxyHostId: string): Promise<{
    projectId: string;
    tagId: string;
    deploymentId: string | null;
    status: 'failed' | 'pending' | 'ready' | 'staging' | 'capability_missing';
    generation: number;
    lastErrorCode: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async reconcile(): Promise<void> {}
  async removeHost(_proxyHostId: string, _nodeId: string | null, _abandonOfflineNode?: boolean): Promise<void> {
    return commercialModuleUnavailable();
  }
  async publishRuntimeConfig(_request: PageRuntimeConfigPublicationRequest): Promise<void> {
    return commercialModuleUnavailable();
  }
  async claimFailedCreateCleanup(_proxyHostId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async stageNodeMigration(
    _proxyHostId: string,
    _sourceNodeId: string,
    _targetNodeId: string
  ): Promise<PageRouteNodeMigration> {
    return commercialModuleUnavailable();
  }
  async commitNodeMigration(_migration: PageRouteNodeMigration): Promise<void> {
    return commercialModuleUnavailable();
  }
  async rollbackNodeMigration(_migration: PageRouteNodeMigration): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupMigratedSource(_proxyHostId: string, _sourceNodeId: string, _connected: boolean): Promise<void> {
    return commercialModuleUnavailable();
  }
  async retarget(_proxyHostId: string, _projectId: string, _tagId: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async stage(_request: PageTagActivationRequest): Promise<Record<string, unknown>> {
    return commercialModuleUnavailable();
  }
  async rollback(_request: PageTagActivationRequest, _progress: Record<string, unknown>): Promise<void> {
    return commercialModuleUnavailable();
  }
}
