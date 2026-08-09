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

  it('keeps the structured port contract and adds the legacy daemon mapping', () => {
    const ports = [
      { hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, protocol: 'tcp' },
      { hostIp: '0.0.0.0', hostPort: 5353, containerPort: 53, protocol: 'udp' },
    ];

    expect(daemonContainerCreateConfig({ image: 'nginx:alpine', ports })).toEqual({
      image: 'nginx:alpine',
      ports,
      port_bindings: { '80/tcp': '8080', '53/udp': '5353' },
    });
  });
});
