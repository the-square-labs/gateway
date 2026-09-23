import { describe, expect, it, vi } from 'vitest';
import { NotificationWebhookService, redactWebhookHeaders, redactWebhookUrl } from './notification-webhook.service.js';

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

describe('NotificationWebhookService audit trail', () => {
  it('records only the redacted webhook URL when a webhook is created', async () => {
    const log = vi.fn();
    const db = {
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: 'hook-1', signingSecret: null }],
        }),
      }),
    };
    const service = new NotificationWebhookService(db as any, { log } as any, {} as any);

    await service.create(
      {
        name: 'Slack',
        url: 'https://hooks.slack.test/services/T000/B000/secret-token',
        method: 'POST',
        enabled: true,
        signingHeader: 'X-Signature-256',
        headers: {},
      } as any,
      'user-1'
    );

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ details: { name: 'Slack', url: 'https://hooks.slack.test/********' } })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
  });
});
