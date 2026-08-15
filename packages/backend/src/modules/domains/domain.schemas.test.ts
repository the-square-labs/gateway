import { describe, expect, it } from 'vitest';
import { CreateDomainSchema } from './domain.schemas.js';

describe('domain schemas', () => {
  it('canonicalizes registered domains before persistence', () => {
    expect(CreateDomainSchema.parse({ domain: ' APP.Example.COM ' }).domain).toBe('app.example.com');
    expect(CreateDomainSchema.parse({ domain: ' *.Example.COM ' }).domain).toBe('*.example.com');
  });
});
