import { describe, expect, it } from 'vitest';
import {
  managedDatabaseBindingListenerConfig,
  requireManagedDatabaseBindingListenerReady,
} from '@/modules/databases/managed-database-binding-host-listener.js';

describe('managed database daemon listener contract', () => {
  it('uses the exact binding network gateway and stable engine port', () => {
    expect(
      managedDatabaseBindingListenerConfig({
        networkName: 'gateway-db-binding',
        gatewayAddress: '172.22.0.1',
        listenPort: 5432,
        allowedSources: ['deployment:slot-b', 'deployment:slot-a', 'deployment:slot-a'],
      })
    ).toEqual({
      networkName: 'gateway-db-binding',
      listenAddress: '172.22.0.1',
      listenPort: 5432,
      allowedSources: ['deployment:slot-a', 'deployment:slot-b'],
    });
  });

  it('requires daemon ACK for the exact listener address', () => {
    expect(() =>
      requireManagedDatabaseBindingListenerReady(
        {
          success: true,
          detail: JSON.stringify({
            listenerStatuses: { 'binding-1': { state: 'ready', address: '172.22.0.1' } },
          }),
        },
        'binding-1',
        '172.22.0.1'
      )
    ).not.toThrow();
    expect(() =>
      requireManagedDatabaseBindingListenerReady(
        { success: true, detail: JSON.stringify({ listenerStatuses: {} }) },
        'binding-1',
        '172.22.0.1'
      )
    ).toThrow('managed database listener is not ready');
  });
});
