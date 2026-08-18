import { describe, expect, it, vi } from 'vitest';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { DockerDeploymentService } from '@/modules/docker/docker-deployment.service.js';
import { DockerMigrationPreflightService } from '@/modules/docker/docker-migration-preflight.js';
import { IntegrationsService } from '@/modules/integrations/integrations.service.js';
import { StatusPageService } from '@/modules/status-page/status-page.service.js';

function deniedPolicy() {
  const error = new Error('license denied');
  return { error, requireFeature: vi.fn(async () => Promise.reject(error)) };
}

describe('Personal entitlement service boundaries', () => {
  it('gates blue/green creation before touching deployment dependencies', async () => {
    const service = new DockerDeploymentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create('node', {} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('blue-green');
  });

  it('gates migration preflight before inspecting either node', async () => {
    const service = new DockerMigrationPreflightService({} as never, {} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.run({} as never, [])).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('cross-node-migration');
  });

  it('gates managed database creation but leaves database-node enrollment outside this boundary', async () => {
    const service = new ManagedDatabaseService({} as never, {} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.create({} as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('managed-databases');
  });

  it('gates only the disabled-to-enabled status page transition', async () => {
    const service = new StatusPageService({} as never, {} as never, {} as never);
    vi.spyOn(service, 'getConfig').mockResolvedValue({ enabled: false } as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(service.updateSettings({ enabled: true } as never, 'user')).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('status-pages');
  });

  it('gates live GitLab registry discovery at the service boundary', async () => {
    const service = new IntegrationsService({} as never, {} as never, {} as never);
    const policy = deniedPolicy();
    service.setLicensePolicyService(policy as never);

    await expect(
      service.gitLabListRegistryRepositories({ id: 'user' } as never, { connectorId: 'connector', project: 'project' })
    ).rejects.toBe(policy.error);
    expect(policy.requireFeature).toHaveBeenCalledWith('registry-discovery');
  });
});
