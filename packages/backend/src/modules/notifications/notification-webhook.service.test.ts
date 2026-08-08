import { describe, expect, it } from 'vitest';
import { redactWebhookHeaders } from './notification-webhook.service.js';

describe('redactWebhookHeaders', () => {
  it('retains header names while masking values', () => {
    expect(redactWebhookHeaders({ Authorization: 'Bearer secret', 'X-Api-Key': 'key' })).toEqual({
      Authorization: '********',
      'X-Api-Key': '********',
    });
  });

  it('preserves absent header configuration', () => {
    expect(redactWebhookHeaders(null)).toBeNull();
  });
});
