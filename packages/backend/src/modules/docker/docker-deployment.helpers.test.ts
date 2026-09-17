import { describe, expect, it } from 'vitest';
import { redactDeploymentWebhookToken } from './docker-deployment-helpers.js';

describe('deployment webhook credential redaction', () => {
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
