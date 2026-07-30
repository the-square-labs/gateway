import { AppError } from '@/middleware/error-handler.js';

export const CANONICAL_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'] as const;

export function validateReasoningMap(advertisedEfforts: string[], map: Record<string, string>): void {
  const duplicates = new Set<string>();
  for (const effort of advertisedEfforts) {
    const normalized = effort.trim().toLowerCase();
    if (!normalized || duplicates.has(normalized)) {
      throw new AppError(
        400,
        'INFERENCE_REASONING_EFFORT_INVALID',
        'Reasoning efforts must be unique non-empty values'
      );
    }
    duplicates.add(normalized);
    if (!map[normalized]?.trim()) {
      throw new AppError(
        400,
        'INFERENCE_REASONING_MAP_INCOMPLETE',
        `Reasoning effort "${normalized}" does not have an upstream mapping`
      );
    }
  }
  const unknown = Object.keys(map).filter((effort) => !duplicates.has(effort));
  if (unknown.length > 0) {
    throw new AppError(400, 'INFERENCE_REASONING_MAP_UNKNOWN', 'Reasoning map contains unadvertised client values', {
      efforts: unknown,
    });
  }
}

export function mapReasoningEffort(
  requested: string | undefined,
  defaultEffort: string | null,
  advertisedEfforts: string[],
  map: Record<string, string>
): { clientEffort?: string; upstreamEffort?: string } {
  const clientEffort = (requested ?? defaultEffort ?? '').trim().toLowerCase();
  if (!clientEffort) return {};
  if (advertisedEfforts.includes(clientEffort)) {
    const upstreamEffort = map[clientEffort];
    if (!upstreamEffort) {
      throw new AppError(500, 'INFERENCE_REASONING_MAP_INVALID', 'Published model reasoning map is incomplete');
    }
    return { clientEffort, upstreamEffort };
  }
  const mappedClientEffort = [...advertisedEfforts]
    .reverse()
    .find((effort) => map[effort]?.trim().toLowerCase() === clientEffort);
  if (!mappedClientEffort) {
    throw new AppError(
      400,
      'INFERENCE_REASONING_EFFORT_UNSUPPORTED',
      `Reasoning effort "${clientEffort}" is unavailable`
    );
  }
  return { clientEffort: mappedClientEffort, upstreamEffort: map[mappedClientEffort] };
}

export function normalizeReasoningEfforts(efforts: string[]): string[] {
  return [...new Set(efforts.map((effort) => effort.trim().toLowerCase()).filter(Boolean))];
}
