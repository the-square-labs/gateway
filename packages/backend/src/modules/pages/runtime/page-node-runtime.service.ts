import type { DrizzleClient } from '@/db/client.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { NginxCertificateDistributionService } from '@/services/nginx-certificate-distribution.service.js';
import type { NodeDispatchService } from '@/services/node-dispatch.service.js';
import type { PageArtifactStore } from '../artifacts/page-artifact-store.js';
import type { PageBindingExpectation, PageBindingInspection } from './page-binding-inspection.js';
export type PageRuntimeConfigBindingKind = 'route' | 'preview';
export interface PagePreviewRuntimeConfigProgress {
  replicaId: string;
  deploymentId: string;
  nodeId: string;
  hostname: string;
  fromGeneration: number;
  toGeneration: number;
}
export class PageNodeRuntimeService {
  // biome-ignore lint/complexity/noUselessConstructor: Preserve the private factory ABI.
  constructor(
    _db: DrizzleClient,
    _artifacts: PageArtifactStore,
    _dispatch: NodeDispatchService,
    _certificates: NginxCertificateDistributionService
  ) {}
  async supportsInspection(_nodeId: string): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  async inspectBindings(
    _bindings: Array<{
      nodeId: string;
      expectation: PageBindingExpectation;
    }>
  ): Promise<PageBindingInspection> {
    return commercialModuleUnavailable();
  }
  async routeExpectation(_input: {
    routeId: string;
    deploymentId: string;
    generation: number;
    stateGeneration: number;
    runtimeConfig: Record<string, unknown>;
  }): Promise<PageBindingExpectation | null> {
    return commercialModuleUnavailable();
  }
  async preflight(_nodeId: string, _requiredBytes: number): Promise<void> {
    return commercialModuleUnavailable();
  }
  async publish(_deploymentId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async refreshProjectFallback(_projectId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async apply(_profile: { domain: string; certificateId: string; labelTemplate: string }): Promise<void> {
    return commercialModuleUnavailable();
  }
  async disable(_profile: { domain: string }): Promise<void> {
    return commercialModuleUnavailable();
  }
  async disableProjectPreviews(_projectId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async reconcileDisabledProjectPreviews(): Promise<void> {}
  async cleanupNode(_profile: { domain: string; nodeId: string }): Promise<void> {
    return commercialModuleUnavailable();
  }
  async activateRoute(_nodeId: string, _routeId: string, _deploymentId: string): Promise<string> {
    return commercialModuleUnavailable();
  }
  async publishRuntimeConfig(
    _nodeId: string,
    _bindingKind: PageRuntimeConfigBindingKind,
    _bindingId: string,
    _generation: number,
    _value: Record<string, unknown>
  ): Promise<string> {
    return commercialModuleUnavailable();
  }
  async activateRuntimeConfig(
    _nodeId: string,
    _bindingKind: PageRuntimeConfigBindingKind,
    _bindingId: string,
    _generation: number
  ): Promise<string> {
    return commercialModuleUnavailable();
  }
  async removeRuntimeConfig(
    _nodeId: string,
    _bindingKind: PageRuntimeConfigBindingKind,
    _bindingId: string
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  async publishPreviewRuntimeConfig(
    _projectId: string,
    _value: Record<string, unknown>
  ): Promise<PagePreviewRuntimeConfigProgress[]> {
    return commercialModuleUnavailable();
  }
  async rollbackPreviewRuntimeConfig(_progress: PagePreviewRuntimeConfigProgress[]): Promise<void> {
    return commercialModuleUnavailable();
  }
  async deactivateRoute(_nodeId: string, _routeId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupDeployment(_nodeId: string, _deploymentId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupRetainedDeployment(_deploymentId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async stageProjectMigration(_projectId: string, _targetNodeId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async cleanupProjectNode(_projectId: string, _nodeId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
}
