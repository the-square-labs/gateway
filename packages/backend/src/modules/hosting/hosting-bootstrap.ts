import { isAlwaysBlockedOutboundIp, normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import { isPubliclyRoutableIp } from '@/modules/nodes/node-service-address.js';
import type { HostingRole } from './hosting-provider.types.js';

const INSTALLERS: Record<HostingRole, string> = {
  nginx: 'setup-node.sh',
  docker: 'setup-docker-node.sh',
  builder: 'setup-docker-node.sh',
  databases: 'setup-database-node.sh',
  storage: 'setup-storage-node.sh',
  monitoring: 'setup-monitoring-node.sh',
  relay: 'setup-relay-node.sh',
};
// Published revision containing the Storage wrapper and self-sufficient Relay installation.
// Update revision and hashes together after publishing installer changes.
export const HOSTING_INSTALLER_REVISION = '04d2c19739cb5e5c16d1a8281d8ef16ec34bcdc6';
export const HOSTING_INSTALLER_BASE = `https://raw.githubusercontent.com/the-square-labs/gateway/${HOSTING_INSTALLER_REVISION}/scripts`;
const INSTALLER_SHA256: Record<string, string> = {
  'setup-node.sh': '22412b365d163ce761cce1d70ab4de1f212b92b04e4c6f0849906ea050b69883',
  'setup-docker-node.sh': '8613d6916c3d8f715ee32cbbeec3a01410fad738b10ac028fa02852366e7c3a7',
  'setup-database-node.sh': '025a97b1603922535184c0211e877915307dbd3f9f608f2dab3862dc050fb20b',
  'setup-storage-node.sh': '150195af603ca9e25ce357211767a5ee48f89d212afa1ab90fdbf6971968741b',
  'setup-monitoring-node.sh': '3aa42d21c3898e0ec83eba9b4416c6e689aaaf3ebdee04d75ff6e3ee16dad602',
  'setup-relay-node.sh': '6b5d2b3429b7dfe36c6270cbf4b02f0aea582d609b72b7221cd7eef8e314bf8d',
};

export function shellArgument(value: string): string {
  if (value.includes('\0') || /[\r\n]/.test(value))
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid bootstrap argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildHostingBootstrap(input: {
  role: HostingRole;
  gateway: string;
  token: string;
  certificateFingerprint: string;
  relayAddress?: string;
  requireCleanHost?: boolean;
  operationMarker?: string;
  expectedOperationMarker?: string;
  waitForCloudInit?: boolean;
}): string {
  if (!INSTALLERS[input.role]) throw new AppError(400, 'HOSTING_ROLE_UNSUPPORTED', 'Unsupported node role');
  if (!input.gateway || !/^sha256:[a-f0-9]{64}$/i.test(input.certificateFingerprint))
    throw new AppError(
      409,
      'HOSTING_GATEWAY_NOT_READY',
      'Configure the Gateway enrollment endpoint and certificate first'
    );
  const url = new URL(`https://${input.gateway}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new AppError(400, 'HOSTING_GATEWAY_INVALID', 'Invalid Gateway enrollment endpoint');
  const args = [
    '--gateway',
    input.gateway,
    '--token',
    input.token,
    '--gateway-cert-sha256',
    input.certificateFingerprint,
  ];
  if (input.role !== 'relay') args.push('--yes');
  if (input.role === 'builder') args.push('--mode', 'builder');
  if (input.role === 'relay') {
    if (!input.relayAddress)
      throw new AppError(400, 'HOSTING_RELAY_ADDRESS_REQUIRED', 'Relay advertised address is required');
    args.push('--advertise-address', input.relayAddress);
  }
  const clean = input.requireCleanHost
    ? `
# A cloned template must never inherit another Gateway host identity or certificate.
if [ -s /var/lib/gateway/host-identity ]; then
  echo 'Gateway identity already exists; refusing to adopt or reinstall a cloned identity' >&2
  exit 42
fi
`
    : '';
  if (
    [input.operationMarker, input.expectedOperationMarker].some(
      (marker) => marker && !/^gw-[0-9a-f-]{36}$/.test(marker)
    )
  )
    throw new AppError(400, 'HOSTING_BOOTSTRAP_INVALID', 'Invalid hosting operation marker');
  return `#!/bin/bash
set -eu
umask 077
mkdir -p /var/lib/gateway
# The lock also fences a timed-out installer that is still running inside the guest.
exec 9>/var/lib/gateway/hosting-install.lock
flock -n 9 || { echo 'A Gateway hosting installer is already running' >&2; exit 44; }
${
  input.waitForCloudInit
    ? `# QGA starts before cloud-init finishes package/network setup. Never race its package manager.
if command -v cloud-init >/dev/null 2>&1; then
  timeout 600 cloud-init status --wait >/dev/null 2>&1 || { echo 'Cloud-init did not finish successfully' >&2; exit 46; }
fi`
    : ''
}
${
  input.expectedOperationMarker
    ? `if [ "$(cat /var/lib/gateway/hosting-operation 2>/dev/null || true)" != ${shellArgument(input.expectedOperationMarker)} ] && { [ -s /var/lib/gateway/hosting-operation ] || [ -s /var/lib/gateway/host-identity ]; }; then
  echo 'This guest is not the original hosting installation target' >&2
  exit 45
fi`
    : ''
}
${clean}
${
  input.operationMarker
    ? `mkdir -p /var/lib/gateway
printf '%s\\n' ${shellArgument(input.operationMarker)} > /var/lib/gateway/hosting-operation
`
    : ''
}
installer_dir=$(mktemp -d)
trap 'rm -f "$installer_dir"/setup-*.sh; rmdir "$installer_dir"' EXIT
fetch_installer() {
local installer="$installer_dir/$1" expected="$2"
if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 "${HOSTING_INSTALLER_BASE}/$1" -o "$installer"
elif command -v wget >/dev/null 2>&1; then
  wget --timeout=120 -qO "$installer" "${HOSTING_INSTALLER_BASE}/$1"
else
  echo 'The selected image needs curl or wget' >&2
  exit 43
fi
printf '%s  %s\\n' "$expected" "$installer" | sha256sum -c - >/dev/null || { echo 'Installer integrity check failed' >&2; exit 47; }
chmod 0700 "$installer"
}
${input.role === 'databases' || input.role === 'storage' ? `fetch_installer 'setup-docker-node.sh' '${INSTALLER_SHA256['setup-docker-node.sh']}'` : ''}
${input.role === 'storage' ? `fetch_installer 'setup-database-node.sh' '${INSTALLER_SHA256['setup-database-node.sh']}'` : ''}
fetch_installer '${INSTALLERS[input.role]}' '${INSTALLER_SHA256[INSTALLERS[input.role]]}'
installer="$installer_dir/${INSTALLERS[input.role]}"
bash "$installer" ${args.map(shellArgument).join(' ')}
`;
}

export function validateHostingGateway(value: string, allowPrivate: boolean): void {
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new AppError(400, 'HOSTING_GATEWAY_INVALID', 'Invalid Gateway enrollment endpoint');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || !url.port)
    throw new AppError(400, 'HOSTING_GATEWAY_INVALID', 'A remotely reachable Gateway endpoint with port is required');
  // Private Proxmox connectivity is allowed. Public provider reachability is checked before ordering.
  const ip = normalizeIp(host);
  if (ip && (isAlwaysBlockedOutboundIp(ip) || (!allowPrivate && !isPubliclyRoutableIp(ip))))
    throw new AppError(
      400,
      'HOSTING_GATEWAY_PRIVATE',
      'Set a publicly reachable Gateway gRPC address in General settings so cloud nodes can connect. No VM was ordered.'
    );
}
