import { describe, expect, it } from 'vitest';
import { filterLocalIpSuggestions, filterPublicIpSuggestions } from './setup-network-suggestions.js';

describe('filterLocalIpSuggestions', () => {
  it('keeps unique private addresses in detection order', () => {
    expect(
      filterLocalIpSuggestions([
        ' 192.168.1.10 ',
        '172.20.0.5',
        '10.0.0.8',
        '169.254.10.2',
        'fd00::10',
        'fe80::1',
        '192.168.1.10',
      ])
    ).toEqual(['192.168.1.10', '172.20.0.5', '10.0.0.8', 'fd00::10']);
  });

  it('drops loopback, link-local, and public addresses from local suggestions', () => {
    expect(
      filterLocalIpSuggestions(['127.0.0.1', '::1', '169.254.10.2', 'fe80::1', '203.0.113.10', '2001:db8::10'])
    ).toEqual([]);
  });
});

describe('filterPublicIpSuggestions', () => {
  it('keeps unique public interface addresses and rejects local or reserved ranges', () => {
    expect(
      filterPublicIpSuggestions([' 8.8.8.8 ', '2001:4860:4860::8888', '10.0.0.8', '192.0.2.10', '8.8.8.8'])
    ).toEqual(['8.8.8.8', '2001:4860:4860::8888']);
  });
});
