import { describe, expect, it } from 'vitest';
import { compareSemver, isMinorCompatible, isNewerVersion, parseSemver } from './semver.js';

describe('release candidate semver ordering', () => {
  it('orders RC increments before the final stable release', () => {
    expect(compareSemver('v2.10.0-rc.2', 'v2.10.0-rc.1')).toBe(1);
    expect(compareSemver('v2.10.0', 'v2.10.0-rc.9')).toBe(1);
    expect(compareSemver('v2.10.0-rc.1', 'v2.10.0')).toBe(-1);
    expect(isNewerVersion('v2.10.0', 'v2.10.0-rc.2')).toBe(true);
  });

  it('parses component suffixes after the RC version', () => {
    expect(parseSemver('v2.10.0-rc.3-nginx')).toEqual({
      major: 2,
      minor: 10,
      patch: 0,
      rc: 3,
    });
  });
});

describe('isMinorCompatible', () => {
  it('treats patch differences within the same minor as compatible', () => {
    expect(isMinorCompatible('2.2.3', '2.2.0')).toBe(true);
  });

  it('treats versions one minor apart as compatible', () => {
    expect(isMinorCompatible('2.2.3', '2.1.6')).toBe(true);
    expect(isMinorCompatible('2.2.3', '2.3.0')).toBe(true);
  });

  it('treats versions two or more minors apart as incompatible', () => {
    expect(isMinorCompatible('2.2.3', '2.0.9')).toBe(false);
    expect(isMinorCompatible('2.2.3', '2.4.0')).toBe(false);
  });

  it('treats different major versions as incompatible', () => {
    expect(isMinorCompatible('2.2.3', '3.2.3')).toBe(false);
  });

  it('treats dev or unparsable versions as compatible', () => {
    expect(isMinorCompatible('dev', '2.2.3')).toBe(true);
    expect(isMinorCompatible('2.2.3', 'main')).toBe(true);
  });
});
