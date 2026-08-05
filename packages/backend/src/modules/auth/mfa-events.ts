/** A realtime channel that only its target user may subscribe to. */
export const MFA_REQUIRED_CHANNEL_PREFIX = 'mfa.required.';

export function mfaRequiredChannel(userId: string): string {
  return `${MFA_REQUIRED_CHANNEL_PREFIX}${userId}`;
}
