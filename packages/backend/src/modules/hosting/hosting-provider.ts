import type { HostingConnection, HostingProviderAdapter } from './hosting-provider.types.js';
import { DigitalOceanHostingAdapter } from './providers/digitalocean.js';
import { HetznerHostingAdapter } from './providers/hetzner.js';
import { HostkeyHostingAdapter } from './providers/hostkey.js';
import { ProxmoxHostingAdapter } from './providers/proxmox.js';

export function createHostingAdapter(connection: HostingConnection): HostingProviderAdapter {
  switch (connection.provider) {
    case 'digitalocean':
      return new DigitalOceanHostingAdapter(connection);
    case 'hetzner':
      return new HetznerHostingAdapter(connection);
    case 'hostkey':
      return new HostkeyHostingAdapter(connection);
    case 'proxmox':
      return new ProxmoxHostingAdapter(connection);
  }
}
