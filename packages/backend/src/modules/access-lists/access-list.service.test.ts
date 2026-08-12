import { describe, expect, it, vi } from 'vitest';
import { AccessListService } from './access-list.service.js';

vi.mock('@/db/schema/index.js', () => ({ accessLists: { id: 'access_lists.id' } }));
vi.mock('@/db/schema/proxy-hosts.js', () => ({
  proxyHosts: {
    accessListId: 'proxy_hosts.access_list_id',
    nodeId: 'proxy_hosts.node_id',
  },
}));

function makeService(deployHtpasswd: ReturnType<typeof vi.fn>) {
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ nodeId: 'nginx-node' }]),
      }),
    }),
  } as any;

  return new AccessListService(db, {} as any, {} as any, {} as any, { deployHtpasswd } as any, {} as any);
}

describe('AccessListService htpasswd deployment', () => {
  it('fails the operation when the daemon rejects credential deployment', async () => {
    const service = makeService(vi.fn().mockResolvedValue({ success: false, error: 'daemon busy' }));

    await expect(
      (service as any).writeHtpasswd('access-list-1', [{ username: 'pd', passwordHash: 'bcrypt-hash' }])
    ).rejects.toMatchObject({ statusCode: 502, code: 'HTPASSWD_DEPLOY_FAILED', message: 'daemon busy' });
  });

  it('writes the expected credential payload to every assigned node', async () => {
    const deployHtpasswd = vi.fn().mockResolvedValue({ success: true });
    const service = makeService(deployHtpasswd);

    await (service as any).writeHtpasswd('access-list-1', [{ username: 'pd', passwordHash: 'bcrypt-hash' }]);

    expect(deployHtpasswd).toHaveBeenCalledWith('nginx-node', 'access-list-1', 'pd:bcrypt-hash\n');
  });
});
