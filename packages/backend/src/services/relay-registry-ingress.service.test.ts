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
  it('requires the private module before enabling external ingress', async () => {
    const { service, relayPolicy, dispatch, proxy } = harness();
    await expect(service.reconcile(enabled, enabled, 'user')).rejects.toMatchObject({
      code: 'COMMERCIAL_MODULE_UNAVAILABLE',
    });
    expect(relayPolicy.ensureInternalRegistryRoute).not.toHaveBeenCalled();
    expect(dispatch.sendNginxRegistryBindings).not.toHaveBeenCalled();
    expect(proxy.upsertRegistrySystemHost).not.toHaveBeenCalled();
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
});
