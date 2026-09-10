import { describe, expect, it } from 'vitest';
import { DockerSourceBindingConfigSchema } from './docker-build.schemas.js';
import { evaluateDockerArtifactPolicy, parseDockerBuildScanSummary } from './docker-build-policy.js';

const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const policy = { vulnerabilityThreshold: 'critical', vulnerabilityScope: 'application' as const };

describe('application vulnerability policy', () => {
  it('keeps the default blocking OS findings and allows explicit report-only OS packages', () => {
    const artifact = { scanSummary: { ...zero, critical: 10, osPackages: { ...zero, critical: 10 } } };
    expect(evaluateDockerArtifactPolicy({}, artifact).decision).toBe('rejected');
    expect(evaluateDockerArtifactPolicy(policy, artifact).decision).toBe('approved');
    expect(artifact.scanSummary.critical).toBe(10);
  });

  it('blocks application findings beyond the retained detail list', () => {
    const scanSummary = parseDockerBuildScanSummary(
      JSON.stringify({
        ...zero,
        critical: 101,
        osPackages: { ...zero, critical: 100 },
        vulnerabilities: Array.from({ length: 100 }, (_, i) => ({
          id: `CVE-${i}`,
          severity: 'critical',
          packageType: 'deb',
        })),
        vulnerabilitiesTruncated: 1,
      })
    );
    expect(scanSummary?.vulnerabilities).toHaveLength(100);
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary })).toMatchObject({
      decision: 'rejected',
      reason: expect.stringContaining('Application vulnerabilities'),
    });
  });

  it.each([
    undefined,
    null,
    {},
    { ...zero, critical: -1 },
    { ...zero, critical: 2 },
    { ...zero, critical: 0.5 },
    { ...zero, critical: '1' },
  ])('does not approve application-only scans with missing or invalid OS counts: %j', (osPackages) => {
    const scanSummary = parseDockerBuildScanSummary(JSON.stringify({ ...zero, critical: 1, osPackages }));
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary }).decision).toBe('error');
  });

  it('retains legacy worker compatibility for the default policy', () => {
    expect(evaluateDockerArtifactPolicy({}, { scanSummary: zero }).decision).toBe('approved');
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary: zero })).toMatchObject({
      decision: 'error',
      reason: expect.stringContaining('updated Build Worker'),
    });
    expect(
      evaluateDockerArtifactPolicy({ ...policy, vulnerabilityThreshold: 'none' }, { scanSummary: zero }).decision
    ).toBe('approved');
  });

  it.each([
    undefined,
    null,
    -1,
    0.5,
    '0',
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects malformed full totals even when the OS aggregate is valid: %j', (critical) => {
    const scanSummary = parseDockerBuildScanSummary(
      JSON.stringify({
        ...zero,
        critical,
        osPackages: zero,
        vulnerabilities: [{ id: 'CVE-app', severity: 'critical', packageType: 'npm' }],
      })
    );
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary }).decision).toBe('error');
  });

  it('normalizes negligible counts consistently and ignores a worker-provided policy scope', () => {
    const scanSummary = parseDockerBuildScanSummary(
      JSON.stringify({
        ...zero,
        unknown: 1,
        negligible: 2,
        osPackages: { ...zero, negligible: 2 },
        policyScope: 'application',
      })
    );
    expect(scanSummary).toMatchObject({ unknown: 3, osPackages: { unknown: 2 } });
    expect(scanSummary).not.toHaveProperty('policyScope');
    expect(evaluateDockerArtifactPolicy(policy, { scanSummary }).decision).toBe('approved');
  });

  it('honors each severity threshold after subtracting OS findings', () => {
    const artifact = { scanSummary: { ...zero, critical: 3, high: 1, osPackages: { ...zero, critical: 3 } } };
    expect(evaluateDockerArtifactPolicy(policy, artifact).decision).toBe('approved');
    expect(evaluateDockerArtifactPolicy({ ...policy, vulnerabilityThreshold: 'high' }, artifact).decision).toBe(
      'rejected'
    );
  });

  it('validates scope values at the source API boundary', () => {
    expect(DockerSourceBindingConfigSchema.shape.policy.parse({ vulnerabilityScope: 'application' })).toEqual({
      vulnerabilityScope: 'application',
    });
    expect(() => DockerSourceBindingConfigSchema.shape.policy.parse({ vulnerabilityScope: 'anything' })).toThrow();
    expect(() => DockerSourceBindingConfigSchema.shape.policy.parse({ vulnerabilityScope: null })).toThrow();
  });
});
