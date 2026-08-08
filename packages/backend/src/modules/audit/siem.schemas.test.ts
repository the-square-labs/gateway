import { describe, expect, it } from 'vitest';
import {
  CreateSiemDestinationSchema,
  SiemCustomHeaderNameSchema,
  SiemEndpointUrlSchema,
  UpdateSiemDestinationSchema,
} from './siem.schemas.js';

describe('SiemEndpointUrlSchema', () => {
  it('accepts a normal HTTPS collector path and custom port', () => {
    expect(SiemEndpointUrlSchema.parse('https://siem.example.test:8443/gateway/audit')).toBe(
      'https://siem.example.test:8443/gateway/audit'
    );
  });

  it.each([
    'http://siem.example.test/audit',
    'https://token@siem.example.test/audit',
    'https://siem.example.test/audit?token=secret',
    'https://siem.example.test/audit#fragment',
  ])('rejects an unsafe or ambiguous collector URL: %s', (url) => {
    expect(SiemEndpointUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('SIEM custom header authentication', () => {
  it('accepts a normal custom header name but protects transport headers', () => {
    expect(SiemCustomHeaderNameSchema.parse('X-API-Key')).toBe('X-API-Key');
    expect(SiemCustomHeaderNameSchema.safeParse('Content-Length').success).toBe(false);
    expect(SiemCustomHeaderNameSchema.safeParse('X-Gateway-Timestamp').success).toBe(false);
    expect(SiemCustomHeaderNameSchema.safeParse('X-Injected\nHeader').success).toBe(false);
  });

  it('requires a custom header name only for custom header authentication', () => {
    expect(
      CreateSiemDestinationSchema.safeParse({
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'custom_header',
        secret: 'api-key',
      }).success
    ).toBe(false);
    expect(
      CreateSiemDestinationSchema.safeParse({
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'custom_header',
        customHeaderName: 'X-API-Key',
        secret: 'api-key',
      }).success
    ).toBe(true);
    expect(
      CreateSiemDestinationSchema.safeParse({
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'bearer',
        customHeaderName: 'X-API-Key',
        secret: 'token',
      }).success
    ).toBe(false);
    expect(UpdateSiemDestinationSchema.safeParse({ authType: 'custom_header' }).success).toBe(false);
  });

  it('rejects line breaks in all authentication values', () => {
    expect(
      CreateSiemDestinationSchema.safeParse({
        name: 'Security Operations',
        url: 'https://siem.example.test/gateway/audit',
        authType: 'bearer',
        secret: 'token\r\nX-Injected: value',
      }).success
    ).toBe(false);
  });
});
