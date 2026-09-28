import { describe, expect, it } from 'vitest';
import {
  INGRESS_HEALTH_LOCATION,
  INGRESS_HEALTH_PATH,
  ingressHealthFromProto,
  ingressHealthOf,
  withIngressHealthLocation,
} from './ingress-health.js';

const RENDERED = `upstream app { server 10.0.0.1:80; }

server {
    listen 80;
    server_name app.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name app.example.com;
    location / { proxy_pass http://app; }
}
`;

describe('ingress health endpoint rendering', () => {
  it('adds the reserved location to every server block once', () => {
    const rendered = withIngressHealthLocation(RENDERED);
    expect(rendered.split(`location = ${INGRESS_HEALTH_PATH} {`)).toHaveLength(3);
    expect(withIngressHealthLocation(rendered)).toBe(rendered);
    expect(rendered).toContain('proxy_pass http://unix:/run/gateway-ingress-health/health.sock:/health;');
    expect(rendered).toContain('proxy_set_header X-Gateway-Ingress-Generation $gateway_ingress_generation;');
  });

  it('matches the location the nginx daemon renders into its own servers', () => {
    // nginx.IngressHealthLocation() in packages/daemons/nginx/internal/nginx/ingress_health.go
    expect(INGRESS_HEALTH_LOCATION).toBe(`    location = /.well-known/gateway-ingress-health {
        access_log off;
        allow all;
        auth_basic off;
        default_type application/json;
        add_header Cache-Control "no-store" always;
        proxy_pass http://unix:/run/gateway-ingress-health/health.sock:/health;
        proxy_set_header Host $host;
        proxy_set_header X-Gateway-Ingress-Generation $gateway_ingress_generation;
        proxy_connect_timeout 2s;
        proxy_send_timeout 3s;
        proxy_read_timeout 3s;
    }
`);
  });

  it('maps the health report field and reads the stored copy', () => {
    expect(ingressHealthFromProto(undefined)).toEqual({});
    const mapped = ingressHealthFromProto({
      serving: false,
      reason: 'no relay transport is connected for 2 Secure Link source(s)',
      configGeneration: '41',
      nginxRunning: true,
      configApplied: true,
      secureLinkSources: 2,
      usableRelayTransports: 0,
      checkedAtUnixMs: '1790640000000',
    });
    expect(mapped.ingressHealth).toEqual({
      serving: false,
      reason: 'no relay transport is connected for 2 Secure Link source(s)',
      configGeneration: 41,
      nginxRunning: true,
      configApplied: true,
      secureLinkSources: 2,
      usableRelayTransports: 0,
      checkedAt: new Date(1790640000000).toISOString(),
    });
    expect(ingressHealthOf({ ...mapped })).toEqual(mapped.ingressHealth);
    expect(ingressHealthOf(null)).toBeNull();
  });
});
