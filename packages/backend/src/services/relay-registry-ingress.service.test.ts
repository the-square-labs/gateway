import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_REGISTRY_INGRESS_ID } from '@/modules/docker/docker-registry.constants.js';
import { RelayRegistryIngressService } from './relay-registry-ingress.service.js';

const enabled = {
  externalAccessEnabled: true,
  externalHostname: 'registry.example.com',
  externalNginxNodeId: '11111111-1111-4111-8111-111111111111',
  externalCertificateId: '22222222-2222-4222-8222-222222222222',
};

function harness() {
  const relayPolicy = {
    ensureInternalRegistryRoute: vi.fn().mockResolvedValue('route-1'),
    revokeOwner: vi.fn().mockResolvedValue(undefined),
  };
  const dispatch = {
    sendNginxRegistryBindings: vi.fn().mockResolvedValue({ success: true }),
  };
  const registry = { getState: vi.fn().mockResolvedValue(enabled) };
  const proxy = {
    upsertRegistrySystemHost: vi.fn().mockResolvedValue({ id: INTERNAL_REGISTRY_INGRESS_ID }),
    disableRegistrySystemHost: vi.fn().mockResolvedValue({ nodeId: enabled.externalNginxNodeId }),
  };
  return {
    service: new RelayRegistryIngressService(
      relayPolicy as never,
      dispatch as never,
      registry as never,
      proxy as never
    ),
    relayPolicy,
    dispatch,
    proxy,
  };
}

describe('RelayRegistryIngressService', () => {
  it('uses a distinct registry ingress route and a blind Nginx transport binding', async () => {
    const { service, relayPolicy, dispatch, proxy } = harness();
    await service.reconcile(
      enabled,
      {
        externalAccessEnabled: false,
        externalHostname: null,
        externalNginxNodeId: null,
        externalCertificateId: null,
      },
      'user-1'
    );

    expect(relayPolicy.ensureInternalRegistryRoute).toHaveBeenCalledWith(
      INTERNAL_REGISTRY_INGRESS_ID,
      enabled.externalNginxNodeId,
      'registry_ingress'
    );
    expect(dispatch.sendNginxRegistryBindings).toHaveBeenCalledWith(enabled.externalNginxNodeId, [
      expect.objectContaining({
        bindingId: INTERNAL_REGISTRY_INGRESS_ID,
        role: 'ingress',
        repository: '*',
        actions: ['pull', 'push'],
        relayOwnerKind: 'registry_ingress',
        authorization: '',
        authorizationExpiresAtUnix: 0,
      }),
    ]);
    expect(proxy.upsertRegistrySystemHost).toHaveBeenCalledWith(
      {
        domain: enabled.externalHostname,
        nodeId: enabled.externalNginxNodeId,
        sslCertificateId: enabled.externalCertificateId,
      },
      'user-1'
    );
  });

  it('withdraws only external ingress and leaves internal registry secure links untouched', async () => {
    const { service, relayPolicy, dispatch, proxy } = harness();
    await service.reconcile(
      {
        externalAccessEnabled: false,
        externalHostname: null,
        externalNginxNodeId: null,
        externalCertificateId: null,
      },
      enabled,
      'user-1'
    );

    expect(proxy.disableRegistrySystemHost).toHaveBeenCalledWith('user-1');
    expect(dispatch.sendNginxRegistryBindings).toHaveBeenCalledWith(enabled.externalNginxNodeId, []);
    expect(relayPolicy.revokeOwner).toHaveBeenCalledWith('registry_ingress', INTERNAL_REGISTRY_INGRESS_ID, {
      allowDeferredSnapshot: true,
    });
    expect(relayPolicy.revokeOwner).not.toHaveBeenCalledWith(
      'registry_secure_link',
      expect.anything(),
      expect.anything()
    );
  });

  it('fails closed and withdraws the route when Nginx config application fails', async () => {
    const { service, relayPolicy, dispatch, proxy } = harness();
    proxy.upsertRegistrySystemHost.mockRejectedValueOnce(new Error('nginx rejected config'));
    await expect(
      service.reconcile(
        enabled,
        {
          externalAccessEnabled: false,
          externalHostname: null,
          externalNginxNodeId: null,
          externalCertificateId: null,
        },
        'user-1'
      )
    ).rejects.toThrow('nginx rejected config');

    expect(dispatch.sendNginxRegistryBindings).toHaveBeenLastCalledWith(enabled.externalNginxNodeId, []);
    expect(relayPolicy.revokeOwner).toHaveBeenCalledWith('registry_ingress', INTERNAL_REGISTRY_INGRESS_ID, {
      allowDeferredSnapshot: true,
    });
  });
});
