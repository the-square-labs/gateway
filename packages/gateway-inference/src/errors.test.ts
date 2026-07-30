import { CliError, errorPayload, redactText, redactValue } from './errors.js';
import { createOutput } from './output.js';

describe('credential redaction', () => {
  it('redacts setup, refresh, and inference credentials recursively', () => {
    expect(redactText('Bearer gwo_secret and gwi_runtime and gwr_refresh')).not.toMatch(/gwo_|gwi_|gwr_/);
    expect(redactText('Stored (gwi_runtime)')).toBe('Stored ([REDACTED])');
    expect(redactText('authorization: Bearer opaque-secret')).toBe('authorization: Bearer [REDACTED]');
    expect(redactValue({ token: 'gwi_secret', nested: { access_token: 'gwo_secret' } })).toEqual({
      token: '[REDACTED]',
      nested: { access_token: '[REDACTED]' },
    });
    expect(errorPayload(new CliError('BROKEN', 'token=gwi_secret'))).toEqual({
      ok: false,
      error: { code: 'BROKEN', message: 'token=[REDACTED]' },
    });
  });

  it('redacts raw create-token values from JSON output', () => {
    let value = '';
    const output = createOutput(true, {
      write: (chunk) => {
        value += String(chunk);
        return true;
      },
    } as NodeJS.WriteStream);
    output.write({ token: 'gwi_raw-secret', prefix: 'gwi_safe' }, () => 'unused');
    expect(value).not.toContain('gwi_raw-secret');
    expect(JSON.parse(value).token).toBe('[REDACTED]');
    expect(JSON.parse(value).prefix).toBe('gwi_safe');
  });
});
