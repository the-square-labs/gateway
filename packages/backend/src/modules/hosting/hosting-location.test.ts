import { expect, it } from 'vitest';
import { hostingLocationLabel, withKnownLocation } from './hosting-location.js';

it.each([
  ['fsn1', 'Falkenstein', 'DE', 'Falkenstein, Germany (fsn1)'],
  ['sin', 'Singapore', 'SG', 'Singapore (sin)'],
  ['NL', undefined, 'NL', 'Netherlands (NL)'],
  ['custom-region', undefined, undefined, 'custom-region'],
  ['custom-region', 'Provider city', undefined, 'Provider city (custom-region)'],
  ['PRIVATE', undefined, 'PRIVATE', 'PRIVATE'],
])('labels %s without changing its code or inventing geography', (code, city, country, expected) => {
  expect(hostingLocationLabel(code!, city, country)).toBe(expected);
});

it('keeps a known location only when the provider does not report one', () => {
  const snapshot = { name: 'vm', location: '' };
  expect(withKnownLocation(snapshot, '5')).toEqual({ name: 'vm', location: '5' });
  expect(withKnownLocation({ ...snapshot, location: 'fsn1' }, 'nbg1').location).toBe('fsn1');
  expect(withKnownLocation(snapshot, '')).toBe(snapshot);
  expect(withKnownLocation(snapshot, undefined)).toBe(snapshot);
});
