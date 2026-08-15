import { describe, expect, it, vi } from 'vitest';
import { CloudflareClient } from './cloudflare-client.js';

describe('CloudflareClient DNS updates', () => {
  it('patches a DNS record so omitted Cloudflare metadata is preserved', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            id: 'record-1',
            type: 'A',
            name: 'app.example.com',
            content: '1.1.1.1',
            ttl: 1,
            proxied: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const client = new CloudflareClient('test-token', fetchImpl);

    await client.updateDnsRecord('zone-1', 'record-1', {
      type: 'A',
      name: 'app.example.com',
      content: '1.1.1.1',
      ttl: 1,
      proxied: true,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/record-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          type: 'A',
          name: 'app.example.com',
          content: '1.1.1.1',
          ttl: 1,
          proxied: true,
        }),
      })
    );
  });
});
