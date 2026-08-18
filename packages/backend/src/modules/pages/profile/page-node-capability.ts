export const NGINX_PAGES_CAPABILITY = 'nginx_pages_v1';
export const NGINX_PAGES_CONFIG_CAPABILITY = 'nginx_pages_config_v1';

export function hasNginxPagesCapability(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const advertised = (capabilities as Record<string, unknown>).capabilities;
  return Array.isArray(advertised) && advertised.includes(NGINX_PAGES_CAPABILITY);
}

export function hasRequiredNginxPagesCapabilities(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const advertised = (capabilities as Record<string, unknown>).capabilities;
  return (
    Array.isArray(advertised) &&
    advertised.includes(NGINX_PAGES_CAPABILITY) &&
    advertised.includes(NGINX_PAGES_CONFIG_CAPABILITY)
  );
}
