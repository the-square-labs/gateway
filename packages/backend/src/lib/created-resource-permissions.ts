import { container } from '@/container.js';
import type { CreatedResourceFamily } from './created-resource-scopes.js';

/** Call once for a newly created resource, before announcing it to its creator. */
export async function grantCreatedResourcePermissions(
  userId: string | null | undefined,
  family: CreatedResourceFamily,
  resourceId: string
): Promise<void> {
  // Internal automation actors without a persisted UUID are not user accounts.
  if (!userId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) return;
  const { AuthService } = await import('@/modules/auth/auth.service.js');
  await container.resolve(AuthService).grantCreatedResourcePermissions(userId, family, resourceId);
}
