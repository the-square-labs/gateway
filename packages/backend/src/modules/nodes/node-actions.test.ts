import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { regenerateNodeEnrollmentTokenForActor } from './node-actions.js';

const NODE = '11111111-1111-4111-8111-111111111111';
const TEAM_FOLDER = '22222222-2222-4222-8222-222222222222';

function nodesService() {
  return {
    get: vi.fn().mockResolvedValue({ id: NODE, folderId: TEAM_FOLDER, metadata: { createdById: 'admin' } }),
    regenerateEnrollmentToken: vi.fn().mockResolvedValue({ enrollmentToken: 'gw_node_v2_new' }),
  };
}

describe('regenerateNodeEnrollmentTokenForActor', () => {
  it('does not let a folder creator take over a pending node someone else created', async () => {
    const service = nodesService();
    const teamMember = { id: 'member', scopes: [`nodes:create:folder/${TEAM_FOLDER}`] };

    await expect(regenerateNodeEnrollmentTokenForActor(teamMember, NODE, service as never)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(service.regenerateEnrollmentToken).not.toHaveBeenCalled();
  });

  it('lets the creator with nodes:create, or a holder of nodes:manage, issue a new token', async () => {
    const service = nodesService();

    await regenerateNodeEnrollmentTokenForActor(
      { id: 'admin', scopes: [`nodes:create:folder/${TEAM_FOLDER}`] },
      NODE,
      service as never
    );
    await regenerateNodeEnrollmentTokenForActor(
      { id: 'member', scopes: [`nodes:manage:${NODE}`] },
      NODE,
      service as never
    );
    expect(service.regenerateEnrollmentToken).toHaveBeenCalledTimes(2);
  });
});
