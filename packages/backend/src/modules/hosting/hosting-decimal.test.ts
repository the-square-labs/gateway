import { describe, expect, it } from 'vitest';
import { compareHostingDecimal, hostingDecimal } from './hosting-decimal.js';

describe('exact provider decimals', () => {
  it.each(['5.9900000000000000', '005.9900', ' 5.99 '])('compares %s without rounding', (value) => {
    expect(hostingDecimal(value)).toBe('5.99');
    expect(compareHostingDecimal(value, '5.99')).toBe(0);
  });
  it('does not lose meaningful digits beyond Number precision', () => {
    expect(compareHostingDecimal('5.9900000000000001', '5.99')).toBe(1);
    expect(compareHostingDecimal('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareHostingDecimal('0.00000000000001', '0')).toBe(1);
    expect(compareHostingDecimal('9', '10')).toBe(-1);
  });
  it.each(['', '-1', 'NaN', '1e3', '1.', '.1', '1'.repeat(129)])('rejects %s', (value) => {
    expect(hostingDecimal(value)).toBeNull();
    expect(compareHostingDecimal('0', value)).toBeNull();
  });
});
