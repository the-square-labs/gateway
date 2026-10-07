import { describe, expect, it } from 'vitest';
import { canDeployInternalCertificate } from './internal-cert-deploy-access.js';

const CERT_ID = '11111111-1111-4111-8111-111111111111';
const CA_ID = '22222222-2222-4222-8222-222222222222';

describe('internal certificate deployment access', () => {
  it('accepts pki:cert:deploy on the certificate or its issuing CA, and key export for compatibility', () => {
    expect(canDeployInternalCertificate(['pki:cert:deploy'], CERT_ID, CA_ID)).toBe(true);
    expect(canDeployInternalCertificate([`pki:cert:deploy:${CERT_ID}`], CERT_ID, CA_ID)).toBe(true);
    expect(canDeployInternalCertificate([`pki:cert:deploy:${CA_ID}`], CERT_ID, CA_ID)).toBe(true);
    expect(canDeployInternalCertificate([`pki:cert:export:${CERT_ID}`], CERT_ID, CA_ID)).toBe(true);
    expect(canDeployInternalCertificate([`pki:cert:export:${CA_ID}`], CERT_ID, CA_ID)).toBe(true);
  });

  it('refuses viewers, other certificates and an unknown issuer', () => {
    expect(canDeployInternalCertificate(['pki:cert:view'], CERT_ID, CA_ID)).toBe(false);
    expect(canDeployInternalCertificate(['pki:cert:deploy:other'], CERT_ID, CA_ID)).toBe(false);
    expect(canDeployInternalCertificate([`pki:cert:deploy:${CA_ID}`], CERT_ID, null)).toBe(false);
  });
});
