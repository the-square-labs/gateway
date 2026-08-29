import type { proxyAdditionalRoutes, proxyHosts } from '@/db/schema/index.js';
import { createChildLogger } from '@/lib/logger.js';
export const logger = createChildLogger('AdditionalRouteService');

export type ProxyHostRow = typeof proxyHosts.$inferSelect;
export type AdditionalRouteRow = typeof proxyAdditionalRoutes.$inferSelect;
export type Input = Record<string, unknown>;

export interface ProxyHostRuntimeAdapter {
  reconcileAdditionalRouteHost(hostId: string): Promise<void>;
}

export interface NormalizedTarget {
  targetKind: 'manual' | 'docker_container' | 'docker_deployment' | 'pages';
  forwardHost?: string | null;
  forwardPort?: number | null;
  forwardScheme: 'http' | 'https';
  dockerNodeId?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerContainerPort?: number | null;
  dockerHostPort?: number | null;
  dockerProtocol?: 'tcp' | null;
  pageProjectId?: string | null;
  pageTagId?: string | null;
}

export interface AdditionalRuntimeConfigProgress {
  routeId: string;
  hostId: string;
  nodeId: string;
  from: number;
  to: number;
  fromRouteGeneration: number;
  toRouteGeneration: number;
}

export interface AdditionalRouteNodeMigration {
  hostId: string;
  sourceNodeId: string;
  targetNodeId: string;
  routeIds: string[];
  generation: number;
  routes: Array<{
    routeId: string;
    targetKind: AdditionalRouteRow['targetKind'];
    generation: number;
    previousSecureLinkId: string | null;
    stagedSecureLinkId: string | null;
    previousIncludePath: string | null;
    previousRuntimeConfigGeneration: number;
  }>;
}

export function isDockerKind(kind: string): kind is 'docker_container' | 'docker_deployment' {
  return kind === 'docker_container' || kind === 'docker_deployment';
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  );
}

export function readInput(input: Input, target: Input | undefined, key: string): unknown {
  return input[key] ?? target?.[key];
}
