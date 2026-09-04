import { isDeepStrictEqual } from 'node:util';

export interface PageBindingExpectation {
  kind: 'preview' | 'route';
  id: string;
  deploymentId: string;
  sha256: string;
  size: number;
  generation: number;
  runtimeConfig: Record<string, unknown>;
  certificateId?: string;
  certificateVersion?: string;
  spaFallback?: boolean;
  fallbackUrl?: string;
  // Included in the snapshot comparison, ignored by the daemon. An in-flight
  // publication must invalidate an earlier match even when its value is equal.
  stateGeneration: number;
}

export type PageBindingInspection = Map<string, { expectation: PageBindingExpectation; matches: boolean }>;

export function bindingInspectionKey(nodeId: string, binding: Pick<PageBindingExpectation, 'kind' | 'id'>): string {
  return `${nodeId}:${binding.kind}:${binding.id}`;
}

export function bindingInspectionMatches(
  inspection: PageBindingInspection | undefined,
  nodeId: string,
  current: PageBindingExpectation | null
): boolean {
  if (current === null) return false;
  const inspected = inspection?.get(bindingInspectionKey(nodeId, current));
  return inspected?.matches === true && isDeepStrictEqual(inspected.expectation, current);
}
