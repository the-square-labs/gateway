import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_DATABASE_CONNECTOR_IMAGE } from '@/config/env.js';
import { ManagedDatabaseBindingService } from './managed-database-bindings.service.js';

function service(
  connectorImage = 'registry.example.com/gateway/database-connector@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  allowDevelopmentConnectorImage = false
) {
  return new ManagedDatabaseBindingService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    connectorImage,
    allowDevelopmentConnectorImage
  );
}

describe('managed database binding provisioning guardrails', () => {
  it('accepts only the daemon-provided absolute tunnel socket path', () => {
    const instance = service() as any;
    expect(
      instance.tunnelSocketPath(JSON.stringify({ socketPath: '/var/lib/docker-daemon/database-tunnel.sock' }))
    ).toBe('/var/lib/docker-daemon/database-tunnel.sock');
    expect(() => instance.tunnelSocketPath(JSON.stringify({ socketPath: '../database-tunnel.sock' }))).toThrow();
  });

  it('does not accept a failed daemon command as provisioned', () => {
    const instance = service() as any;
    expect(() => instance.requireSuccess({ success: false, error: 'sensitive daemon detail' })).toThrow(
      'daemon operation failed'
    );
  });

  it('allows only the fixed local connector image with the explicit development flag', () => {
    const development = service(DEVELOPMENT_DATABASE_CONNECTOR_IMAGE, true) as any;
    const production = service(DEVELOPMENT_DATABASE_CONNECTOR_IMAGE, false) as any;
    const arbitrary = service('registry.example.com/connector:dev', true) as any;

    expect(() => development.assertConnectorImage()).not.toThrow();
    expect(development.connectorImageAction()).toBe('ensure-local');
    expect(() => production.assertConnectorImage()).toThrow('immutable digest');
    expect(production.connectorImageAction()).toBe('ensure');
    expect(() => arbitrary.assertConnectorImage()).toThrow('immutable digest');
  });
});
