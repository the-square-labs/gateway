import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_NEXT_UPSTREAM_DIRECTIVES,
  managedSecureLinkUpstreamBody,
  withAvailabilityNextUpstream,
} from './nginx-availability-upstream.js';

const upstream = 'gateway_secure_link_11111111_1111_4111_8111_111111111111';

describe('Availability next-upstream directives (D6)', () => {
  it('retries the next member on errors and 502/503/504, never non-idempotent requests, within bounds', () => {
    const rendered = withAvailabilityNextUpstream(
      `server {\n    location / {\n        proxy_pass http://${upstream};\n    }\n    location /other/ {\n        proxy_pass http://127.0.0.1:81;\n    }\n}\n`,
      [upstream]
    );
    expect(rendered).toContain(
      `        proxy_pass http://${upstream};\n${AVAILABILITY_NEXT_UPSTREAM_DIRECTIVES.map((line) => `        ${line}`).join('\n')}\n`
    );
    expect(rendered.match(/proxy_next_upstream /g)).toHaveLength(1);
    expect(rendered).not.toContain('non_idempotent');
    expect(rendered).toContain('        proxy_pass http://127.0.0.1:81;\n    }');
  });

  it('leaves tries and timeout to a template that sets them, and adds proxy_next_upstream, which nginx merges', () => {
    const template = `location / {\n    proxy_next_upstream_tries 2;\n    proxy_next_upstream_timeout 3s;\n    proxy_pass https://${upstream}/api;\n}\n`;
    const rendered = withAvailabilityNextUpstream(template, [upstream]);
    expect(rendered.match(/proxy_next_upstream_tries/g)).toHaveLength(1);
    expect(rendered.match(/proxy_next_upstream_timeout/g)).toHaveLength(1);
    expect(rendered).toContain(
      `    proxy_pass https://${upstream}/api;\n    proxy_next_upstream error timeout http_502 http_503 http_504;\n}`
    );
  });

  it('touches nothing without Availability upstreams', () => {
    const template = `location / {\n    proxy_pass http://${upstream};\n}\n`;
    expect(withAvailabilityNextUpstream(template, [])).toBe(template);
  });
});

describe('Availability upstream members (B-13)', () => {
  it('lists every member once more as a backup that is never taken out, so a serving member is always tried', () => {
    expect(
      managedSecureLinkUpstreamBody(['/run/gateway-secure-links/a.sock', '/run/gateway-secure-links/b.sock'], true)
    ).toBe(
      [
        '    least_conn;',
        '    server unix:/run/gateway-secure-links/a.sock max_fails=1 fail_timeout=1s;',
        '    server unix:/run/gateway-secure-links/b.sock max_fails=1 fail_timeout=1s;',
        '    server unix:/run/gateway-secure-links/a.sock max_fails=0 backup;',
        '    server unix:/run/gateway-secure-links/b.sock max_fails=0 backup;',
        '    keepalive 64;',
      ].join('\n')
    );
  });

  it('leaves a plain Secure Link upstream as it was', () => {
    expect(managedSecureLinkUpstreamBody(['/run/gateway-secure-links/a.sock'], false)).toBe(
      '    server unix:/run/gateway-secure-links/a.sock;\n    keepalive 64;'
    );
  });
});
