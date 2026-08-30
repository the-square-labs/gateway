import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { hasChannelAccess } from './events-channel-access.js';

describe('SSL certificate event channel access', () => {
  it('separates folder layout events from certificate lifecycle metadata', () => {
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:folders:manage'], 'ssl.cert.changed')).toBe(false);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.folder.changed')).toBe(true);
    expect(hasChannelAccess(['ssl:cert:view'], 'ssl.cert.changed')).toBe(true);
  });
});
