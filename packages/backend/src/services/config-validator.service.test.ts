import { describe, expect, it } from 'vitest';
import { ConfigValidatorService } from './config-validator.service.js';

describe('ConfigValidatorService', () => {
  const service = new ConfigValidatorService();

  it('rejects top-level upstream directives in advanced mode', () => {
    const result = service.validate(
      `
proxy_pass http://127.0.0.1:3000;
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden top-level directive "proxy_pass" found on line 1');
  });

  it('allows upstream directives inside custom non-root location blocks', () => {
    const result = service.validate(
      `
location /api/ {
  proxy_pass http://127.0.0.1:3000/api/;
  proxy_http_version 1.1;
}
`.trim()
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('allows inline custom non-root location blocks', () => {
    const result = service.validate(
      'location /api/ { proxy_http_version 1.1; proxy_pass http://127.0.0.1:3000/api/; }'
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['allow', 'allow all;'],
    ['deny', 'deny all;'],
    ['auth_basic', 'auth_basic off;'],
  ])('rejects %s overrides inside custom locations', (directive, statement) => {
    const result = service.validate(
      `location /api/ {
  ${statement}
  proxy_pass http://127.0.0.1:3000/api/;
}`
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`Forbidden directive "${directive}" found on line 2`);
  });

  it('rejects forbidden directives even when chained after safe directives on one line', () => {
    const result = service.validate('proxy_http_version 1.1; proxy_pass http://127.0.0.1:3000;');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden top-level directive "proxy_pass" found on line 1');
  });

  it('rejects custom root location blocks', () => {
    const result = service.validate(
      `
location / {
  proxy_pass http://127.0.0.1:3000;
}
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden root location block found on line 1');
  });

  it('keeps dangerous directives blocked even inside nested blocks', () => {
    const result = service.validate(
      `
location /api/ {
  include /etc/nginx/conf.d/shared.conf;
}
`.trim()
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "include" found on line 2');
  });

  it('rejects dangerous directives in raw mode by default', () => {
    const result = service.validate(
      `
server {
  include /etc/nginx/conf.d/private.conf;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "include" found on line 2');
  });

  it.each([
    'ssl_certificate_by_lua_block { ngx.say(1) }',
    'ssl_certificate_by_lua_file /tmp/a.lua;',
  ])('rejects lua execution directives in advanced mode: %s', (snippet) => {
    const result = service.validate(snippet);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "lua_" found on line 1');
  });

  it.each([
    'ssl_certificate_by_lua_block { ngx.say(1) }',
    'access_by_lua_file /tmp/a.lua;',
  ])('rejects lua execution directives in raw mode without bypass: %s', (snippet) => {
    const result = service.validate(snippet, true);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "lua_" found on line 1');
  });

  it.each(['env FOO;', 'env\tFOO;'])('rejects raw env directives with nginx whitespace: %s', (snippet) => {
    const result = service.validate(snippet, true);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "env" found on line 1');
  });

  it('allows raw mode dangerous directives only with raw bypass', () => {
    const result = service.validate(
      `
server {
  include /etc/nginx/conf.d/private.conf;
}
`.trim(),
      true,
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does not apply advanced top-level restrictions to raw mode', () => {
    const result = service.validate(
      `
location / {
  proxy_pass http://127.0.0.1:3000;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('allows ssl certificate directives in raw mode without bypass', () => {
    const result = service.validate(
      `
server {
  ssl_certificate /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
}
`.trim(),
      true
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('keeps advanced snippet ssl key directives forbidden', () => {
    const result = service.validate('ssl_certificate_key /etc/nginx/certs/privkey.pem;');

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Forbidden directive "ssl_certificate_key" found on line 1');
  });
});
