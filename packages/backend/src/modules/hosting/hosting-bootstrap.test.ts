import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildHostingBootstrap,
  HOSTING_INSTALLER_REVISION,
  shellArgument,
  validateHostingGateway,
} from './hosting-bootstrap.js';
import type { HostingRole } from './hosting-provider.types.js';

const base = {
  gateway: 'gateway.example.test:9443',
  token: 'gw_node_v2_selector_secret',
  certificateFingerprint: `sha256:${'a'.repeat(64)}`,
};
describe('hosting bootstrap reuses released role installers', () => {
  it('waits for cloud-init only for independent guest-agent bootstrap, never from user-data itself', () => {
    const guest = buildHostingBootstrap({ ...base, role: 'docker', waitForCloudInit: true });
    expect(guest).toContain('timeout 600 cloud-init status --wait');
    expect(guest.indexOf('cloud-init status --wait')).toBeLessThan(guest.indexOf('curl --fail'));
    expect(buildHostingBootstrap({ ...base, role: 'docker' })).not.toContain('cloud-init status --wait');
  });
  it.each<[HostingRole, string]>([
    ['nginx', 'setup-node.sh'],
    ['docker', 'setup-docker-node.sh'],
    ['builder', 'setup-docker-node.sh'],
    ['databases', 'setup-database-node.sh'],
    ['monitoring', 'setup-monitoring-node.sh'],
    ['relay', 'setup-relay-node.sh'],
  ])('renders %s without inventing another install engine', (role, installer) => {
    const script = buildHostingBootstrap({
      ...base,
      role,
      relayAddress: role === 'relay' ? 'relay.example.test:9443' : undefined,
    });
    expect(script).toContain(`/${HOSTING_INSTALLER_REVISION}/scripts/`);
    expect(script).toContain(`fetch_installer '${installer}'`);
    expect(script).not.toContain('/main/');
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('bash "$installer"'));
    if (role === 'databases') expect(script).toContain("fetch_installer 'setup-docker-node.sh'");
    expect(script).toContain("'--gateway' 'gateway.example.test:9443'");
    expect(script).toContain("'--gateway-cert-sha256'");
    if (role === 'builder') expect(script).toContain("'--mode' 'builder'");
    if (role === 'relay') expect(script).toContain("'--advertise-address' 'relay.example.test:9443'");
    expect(script).not.toContain('apt install');
    expect(() => execFileSync('bash', ['-n'], { input: script })).not.toThrow();
  });
  it('fails clean cloned identity before fetching an installer', () => {
    const script = buildHostingBootstrap({ ...base, role: 'docker', requireCleanHost: true });
    expect(script.indexOf('[ -s /var/lib/gateway/host-identity ]')).toBeLessThan(script.indexOf('curl --fail'));
    expect(script).toContain('exit 42');
    expect(script).not.toContain('rm -rf');
  });
  it('quotes shell metacharacters and rejects multiline or null arguments', () => {
    expect(shellArgument("x'; touch /tmp/pwn; '")).toBe("'x'\\''; touch /tmp/pwn; '\\'''");
    expect(() => shellArgument('x\ny')).toThrow();
    expect(() => shellArgument('x\0y')).toThrow();
    expect(() => buildHostingBootstrap({ ...base, role: 'relay' })).toThrow();
  });
  it('rejects loopback/metadata endpoints and private destinations for external clouds', () => {
    for (const target of ['127.0.0.1:9443', '[::1]:9443', '169.254.169.254:9443', 'localhost:9443'])
      expect(() => validateHostingGateway(target, true)).toThrow();
    for (const target of ['10.0.0.1:9443', '[fd00::1]:9443', '203.0.113.1:9443'])
      expect(() => validateHostingGateway(target, false)).toThrow();
    expect(() => validateHostingGateway('10.0.0.1:9443', true)).not.toThrow();
    expect(() => validateHostingGateway('gateway.example.test:9443', false)).not.toThrow();
  });
});
