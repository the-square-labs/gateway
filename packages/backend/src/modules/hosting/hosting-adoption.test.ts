import { describe, expect, it } from 'vitest';
import { evaluateHostingAdoption, type HostingNodeEvidence, type HostingResourceEvidence } from './hosting-evidence.js';
import { hostingCapabilities } from './hosting-provider.types.js';

const now = Date.parse('2026-09-05T09:00:00Z');
const date = new Date(now).toISOString();
function resource(id: string, ip: string, mac?: string): HostingResourceEvidence {
  return {
    id,
    managedHostIdentity: null,
    snapshot: {
      remoteId: id,
      kind: 'vm',
      name: id,
      location: 'eu',
      powerState: 'running',
      cpu: 2,
      memoryMb: 2048,
      diskGb: 32,
      addresses: [{ ip, mac, direct: true }],
      incarnation: `created-${id}`,
      capabilities: hostingCapabilities({}),
      observedAt: date,
    },
  };
}
function node(nodeId: string, ip: string, mac?: string, hostIdentityId = `host-${nodeId}`): HostingNodeEvidence {
  return { nodeId, hostIdentityId, observedAt: date, interfaces: [{ ip, mac }] };
}
const match = (resources: HostingResourceEvidence[], nodes: HostingNodeEvidence[], complete = true) =>
  evaluateHostingAdoption({ resources, nodes, inventoryComplete: complete, now });

describe('fully automatic hosting adoption evidence', () => {
  it('matches a unique direct public interface address without a manual step', () => {
    expect(match([resource('r1', '8.8.8.8')], [node('n1', '8.8.8.8')])[0]).toMatchObject({
      hostIdentityId: 'host-n1',
      nodeIds: ['n1'],
      reason: 'direct_ip',
    });
  });
  it('does not adopt from a private IP alone or an egress address', () => {
    expect(match([resource('r1', '10.0.0.5')], [node('n1', '10.0.0.5')])[0].hostIdentityId).toBeNull();
    const r = resource('r1', '8.8.8.8');
    r.snapshot.addresses[0].direct = false;
    expect(match([r], [node('n1', '8.8.8.8')])[0].hostIdentityId).toBeNull();
  });
  it('does not classify documentation or protocol ranges as globally routable', () => {
    for (const ip of ['203.0.113.5', '192.0.2.1', '2001:db8::1', '100.64.0.2']) {
      expect(match([resource('r1', ip)], [node('n1', ip)])[0].hostIdentityId).toBeNull();
    }
  });
  it('matches a Proxmox CT by private interface IP and MAC', () => {
    const r = resource('250', '10.0.0.5', 'AA:BB:CC:DD:EE:FF');
    r.snapshot.kind = 'ct';
    expect(match([r], [node('n1', '10.0.0.5', 'aa:bb:cc:dd:ee:ff')])[0].reason).toBe('interface_match');
  });
  it('refuses identical IP/MAC in two attached networks rather than choosing one', () => {
    const r1 = resource('r1', '10.0.0.5', 'aa:bb:cc:dd:ee:ff');
    const r2 = resource('r2', '10.0.0.5', 'aa:bb:cc:dd:ee:ff');
    expect(
      match([r1, r2], [node('n1', '10.0.0.5', 'aa:bb:cc:dd:ee:ff')]).every(
        (decision) => decision.reason === 'ambiguous'
      )
    ).toBe(true);
  });
  it('does not bind two different host groups to one provider resource', () => {
    expect(match([resource('r1', '8.8.8.8')], [node('n1', '8.8.8.8'), node('n2', '8.8.8.8')])[0].reason).toBe(
      'ambiguous'
    );
  });
  it('allows multiple daemon roles on one proven host', () => {
    expect(
      match(
        [resource('r1', '8.8.8.8')],
        [node('docker', '8.8.8.8', undefined, 'same-host'), node('nginx', '8.8.8.8', undefined, 'same-host')]
      )[0]
    ).toMatchObject({ hostIdentityId: 'same-host', nodeIds: ['docker', 'nginx'] });
  });
  it('uses independent guest identity even if the daemon is currently offline', () => {
    const r = resource('r1', '10.0.0.5');
    r.guestHostIdentity = 'host-n1';
    const n = node('n1', '10.0.0.5');
    n.observedAt = null;
    expect(match([r], [n])[0].reason).toBe('guest_identity');
  });
  it('rejects contradictory guest identity and MAC rather than trusting public IP', () => {
    const r = resource('r1', '8.8.8.8');
    r.guestHostIdentity = 'different';
    expect(match([r], [node('n1', '8.8.8.8')])[0].hostIdentityId).toBeNull();
    expect(
      match([resource('r1', '8.8.8.8', 'aa:bb:cc:dd:ee:ff')], [node('n1', '8.8.8.8', '00:11:22:33:44:55')])[0]
        .hostIdentityId
    ).toBeNull();
  });
  it('does not use partial pagination, stale/future evidence or missing host identity', () => {
    const r = resource('r1', '8.8.8.8');
    const n = node('n1', '8.8.8.8');
    expect(match([r], [n], false)[0].reason).toBe('incomplete_inventory');
    expect(match([r], [{ ...n, observedAt: new Date(now - 301000).toISOString() }])[0].hostIdentityId).toBeNull();
    expect(match([r], [{ ...n, observedAt: new Date(now + 60000).toISOString() }])[0].hostIdentityId).toBeNull();
    expect(match([r], [{ ...n, hostIdentityId: null }])[0].hostIdentityId).toBeNull();
  });
  it('preserves existing bindings instead of reassigning a reused IP', () => {
    expect(
      evaluateHostingAdoption({
        resources: [resource('new', '8.8.8.8')],
        nodes: [node('n1', '8.8.8.8')],
        existingBindings: [{ nodeId: 'n1', resourceId: 'old' }],
        inventoryComplete: true,
        now,
      })[0].reason
    ).toBe('already_bound_elsewhere');
  });
});
