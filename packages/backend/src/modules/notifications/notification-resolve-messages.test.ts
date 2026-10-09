import { describe, expect, it } from 'vitest';
import { defaultResolveMessage, resolveTemplateOf } from './notification-resolve-messages.js';

describe('resolve messages', () => {
  it('tells the recovery for the rule, with how long the alert lasted', () => {
    const proxyDown = { name: 'Proxy host down', type: 'event', category: 'proxy', eventPattern: 'health.offline' };
    expect(defaultResolveMessage(proxyDown, 'pearldivergame.com', { fired: { duration: 782 } })).toBe(
      'Proxy host pearldivergame.com is back online after 13m 2s.'
    );
    expect(
      defaultResolveMessage(
        { name: 'Node down', type: 'event', category: 'node', eventPattern: 'offline' },
        'pd-backend'
      )
    ).toBe('Node pd-backend is back online.');
    expect(
      defaultResolveMessage({ name: 'CPU', type: 'threshold', category: 'node', metric: 'cpu' }, 'node-1', {
        metric: { value: 41.96 },
        fired: { duration: 300 },
      })
    ).toBe('CPU Usage on node-1 is back to normal at 42% after 5m 0s.');
    expect(
      defaultResolveMessage(
        { name: 'VM', type: 'event', category: 'hosting_vm', eventPattern: 'power.stopped' },
        'vm-7'
      )
    ).toBe('VM vm-7 is no longer stopped.');
    expect(
      defaultResolveMessage(
        { name: 'Storage', type: 'event', category: 'pages', eventPattern: 'cleanup.needs_attention' },
        'site'
      )
    ).toBe('Cleanup Needs Attention has cleared on site.');
  });

  it('renders the resolve message, or a firing message written for both states, never a plain firing message', () => {
    expect(resolveTemplateOf({ messageTemplate: 'Proxy host {{resource.name}} has gone offline' })).toBeNull();
    expect(resolveTemplateOf({ messageTemplate: 'down', resolveMessageTemplate: '{{resource.name}} is back' })).toBe(
      '{{resource.name}} is back'
    );
    expect(resolveTemplateOf({ messageTemplate: 'x', resolveMessageTemplate: '  ' })).toBeNull();
    const both = '{{#if (eq alert.status "resolved")}}up{{else}}down{{/if}}';
    expect(resolveTemplateOf({ messageTemplate: both })).toBe(both);
  });
});
