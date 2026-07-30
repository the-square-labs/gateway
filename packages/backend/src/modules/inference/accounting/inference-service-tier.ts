export const FAST_SERVICE_TIER = 'priority';
export const FAST_SERVICE_TIER_MULTIPLIER = 2;

export function normalizeServiceTier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 32) return null;
  return normalized === 'fast' ? FAST_SERVICE_TIER : normalized;
}

export function serviceTierCreditMultiplier(
  sourceType: 'subscription' | 'api',
  providerId: string,
  serviceTier: string | null
): number {
  return sourceType === 'subscription' && providerId === 'openai' && serviceTier === FAST_SERVICE_TIER
    ? FAST_SERVICE_TIER_MULTIPLIER
    : 1;
}
