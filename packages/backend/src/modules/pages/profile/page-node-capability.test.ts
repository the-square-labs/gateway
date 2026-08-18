import { describe, expect, it } from 'vitest';
import {
  hasNginxPagesCapability,
  hasRequiredNginxPagesCapabilities,
  NGINX_PAGES_CAPABILITY,
  NGINX_PAGES_CONFIG_CAPABILITY,
} from './page-node-capability.js';

describe('Nginx Pages capability', () => {
  it('requires the exact advertised protocol capability', () => {
    expect(hasNginxPagesCapability({ capabilities: [NGINX_PAGES_CAPABILITY] })).toBe(true);
    expect(hasNginxPagesCapability({ capabilities: ['nginx_pages_v0'] })).toBe(false);
    expect(hasNginxPagesCapability({ nginxPagesV1: true })).toBe(false);
    expect(hasNginxPagesCapability(null)).toBe(false);
  });

  it('requires the separate runtime-config capability for the complete Pages runtime', () => {
    expect(
      hasRequiredNginxPagesCapabilities({
        capabilities: [NGINX_PAGES_CAPABILITY, NGINX_PAGES_CONFIG_CAPABILITY],
      })
    ).toBe(true);
    expect(hasRequiredNginxPagesCapabilities({ capabilities: [NGINX_PAGES_CAPABILITY] })).toBe(false);
  });
});
