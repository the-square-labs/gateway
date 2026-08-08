import { describe, expect, it } from 'vitest';
import {
  deploymentRoutesEqual,
  imageWithTag,
  inactiveSlot,
  isBusyDeploymentStatus,
  normalizeHealth,
  normalizeRoutes,
  redactDeploymentWebhookToken,
  shortId,
} from './docker-deployment-helpers.js';

describe('Docker deployment helpers', () => {
  it('normalizes route inputs and rejects invalid primary or duplicate host ports', () => {
    const routes = [
      { hostPort: 8080, containerPort: 3000, isPrimary: true },
      { hostPort: 8081, containerPort: 3001, isPrimary: false },
    ];

    expect(normalizeRoutes(routes)).toBe(routes);
    expect(() =>
      normalizeRoutes([
        { hostPort: 8080, containerPort: 3000, isPrimary: false },
        { hostPort: 8081, containerPort: 3001, isPrimary: false },
      ])
    ).toThrow('Exactly one route must be primary');
    expect(() =>
      normalizeRoutes([
        { hostPort: 8080, containerPort: 3000, isPrimary: true },
        { hostPort: 8080, containerPort: 3001, isPrimary: false },
      ])
    ).toThrow('Host port 8080 is duplicated');
  });

  it('compares routes independent of order', () => {
    expect(
      deploymentRoutesEqual(
        [
          { hostPort: 8080, containerPort: 3000, isPrimary: true },
          { hostPort: 8081, containerPort: 3001, isPrimary: false },
        ],
        [
          { hostPort: 8081, containerPort: 3001, isPrimary: false },
          { hostPort: 8080, containerPort: 3000, isPrimary: true },
        ]
      )
    ).toBe(true);
    expect(
      deploymentRoutesEqual(
        [{ hostPort: 8080, containerPort: 3000, isPrimary: true }],
        [{ hostPort: 8080, containerPort: 3001, isPrimary: true }]
      )
    ).toBe(false);
  });

  it('validates health status ranges', () => {
    const health = {
      path: '/health',
      statusMin: 200,
      statusMax: 399,
      timeoutSeconds: 5,
      intervalSeconds: 10,
      successThreshold: 2,
      startupGraceSeconds: 10,
      deployTimeoutSeconds: 120,
    };

    expect(normalizeHealth(health)).toBe(health);
    expect(() => normalizeHealth({ ...health, statusMin: 500, statusMax: 200 })).toThrow(
      'Minimum healthy status cannot be greater than maximum status'
    );
  });

  it('derives deployment identifiers, slots, busy state, and image tags', () => {
    expect(inactiveSlot('blue')).toBe('green');
    expect(inactiveSlot('green')).toBe('blue');
    expect(shortId('12345678-90ab-cdef-1234-567890abcdef')).toBe('1234567890ab');
    expect(isBusyDeploymentStatus('deploying')).toBe(true);
    expect(isBusyDeploymentStatus('ready')).toBe(false);
    expect(imageWithTag('registry.example.com/team/app:old', 'new')).toBe('registry.example.com/team/app:new');
    expect(imageWithTag('registry.example.com/team/app@sha256:deadbeef', 'new')).toBe(
      'registry.example.com/team/app:new@sha256:deadbeef'
    );
    expect(imageWithTag('registry.example.com/team/app:old')).toBe('registry.example.com/team/app:old');
  });

  it('redacts deployment webhook bearer tokens unless the caller has webhook scope', () => {
    const deployment = {
      id: 'deployment-1',
      webhook: { id: 'webhook-1', token: 'secret-token', enabled: true },
    };

    expect(redactDeploymentWebhookToken(deployment, false)).toEqual({
      id: 'deployment-1',
      webhook: { id: 'webhook-1', token: '[REDACTED]', enabled: true },
    });
    expect(redactDeploymentWebhookToken(deployment, true)).toBe(deployment);
    expect(deployment.webhook.token).toBe('secret-token');
  });
});
