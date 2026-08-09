import { describe, expect, it } from 'vitest';
import { daemonContainerCreateConfig } from './docker-container-mutation-operations.js';

describe('daemonContainerCreateConfig', () => {
  it('serializes the API environment record to the daemon string-list contract', () => {
    const input = {
      image: 'nginx:alpine',
      env: { APP_ENV: 'e2e', EMPTY: '' },
    };

    expect(daemonContainerCreateConfig(input)).toEqual({
      image: 'nginx:alpine',
      env: ['APP_ENV=e2e', 'EMPTY='],
    });
    expect(input.env).toEqual({ APP_ENV: 'e2e', EMPTY: '' });
  });
});
