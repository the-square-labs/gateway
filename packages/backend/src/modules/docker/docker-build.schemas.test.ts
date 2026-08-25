import { describe, expect, it } from 'vitest';
import {
  DockerBuildCommitShaSchema,
  DockerInternalRegistrySettingsSchema,
  DockerSourceBindingUpsertSchema,
} from './docker-build.schemas.js';

const containerBinding = {
  target: { kind: 'container' as const, nodeId: '11111111-1111-4111-8111-111111111111', containerName: 'api' },
  connectorId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  branch: 'main',
};

describe('Docker source binding schemas', () => {
  it('accepts one exact container target shape', () => {
    const result = DockerSourceBindingUpsertSchema.parse(containerBinding);
    expect(result.dockerfilePath).toBe('Dockerfile');
    expect(result.contextPath).toBe('.');
    expect(result.autoBuild).toBe(true);
    expect(result.autoDeploy).toBe(true);
    expect(result.policy).toEqual({});
  });

  it('rejects repository paths that can escape the checkout', () => {
    expect(
      DockerSourceBindingUpsertSchema.safeParse({ ...containerBinding, dockerfilePath: '../Dockerfile' }).success
    ).toBe(false);
    expect(DockerSourceBindingUpsertSchema.safeParse({ ...containerBinding, contextPath: '/srv/repo' }).success).toBe(
      false
    );
  });

  it('requires one repository Compose file for a Compose project target', () => {
    const target = {
      kind: 'compose_project' as const,
      composeProjectId: '44444444-4444-4444-8444-444444444444',
    };
    expect(DockerSourceBindingUpsertSchema.safeParse({ ...containerBinding, target }).success).toBe(false);
    const parsed = DockerSourceBindingUpsertSchema.parse({
      ...containerBinding,
      target,
      composeFilePath: 'deploy/compose.yaml',
    });
    expect(parsed.composeFilePath).toBe('deploy/compose.yaml');
    expect(parsed.composeVariables).toEqual({});
    expect(parsed.composeSecretKeys).toEqual([]);
    expect(
      DockerSourceBindingUpsertSchema.safeParse({ ...containerBinding, composeFilePath: 'compose.yaml' }).success
    ).toBe(false);
  });

  it('requires the complete external registry ingress tuple', () => {
    expect(DockerInternalRegistrySettingsSchema.safeParse({ externalAccessEnabled: false }).success).toBe(true);
    expect(DockerInternalRegistrySettingsSchema.safeParse({ externalAccessEnabled: true }).success).toBe(false);
    expect(
      DockerInternalRegistrySettingsSchema.safeParse({
        externalAccessEnabled: true,
        externalHostname: 'registry.example.com',
        externalNginxNodeId: '44444444-4444-4444-8444-444444444444',
        externalCertificateId: '55555555-5555-4555-8555-555555555555',
      }).success
    ).toBe(true);
  });

  it('accepts only immutable hexadecimal commit identifiers', () => {
    expect(DockerBuildCommitShaSchema.safeParse('a'.repeat(40)).success).toBe(true);
    expect(DockerBuildCommitShaSchema.safeParse('main').success).toBe(false);
  });
});
