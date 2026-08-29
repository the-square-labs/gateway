import { describe, expect, it } from 'vitest';
import { redactWebhookHeaders, redactWebhookUrl } from './notification-webhook.service.js';

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

describe('redactWebhookUrl', () => {
  it('retains only the webhook origin', () => {
    expect(redactWebhookUrl('https://hooks.example.test/services/T/B/secret-token')).toBe(
      'https://hooks.example.test/********'
    );
  });

  it('masks malformed webhook URLs completely', () => {
    expect(redactWebhookUrl('not-a-url')).toBe('********');
  });
});
