import { expect, it } from 'vitest';
import { hostingLocationLabel } from './hosting-location.js';

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
