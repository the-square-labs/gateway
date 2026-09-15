import { describe, expect, it } from 'vitest';
import { validateEnrollmentDaemonProfile, validateRegisteredDaemonProfile } from './node-daemon-profile.js';

describe('builder node daemon profile', () => {
  it('accepts unified storage and compatible legacy database identities without generic Docker privileges', () => {
    for (const role of ['storage', 'databases']) {
      expect(validateEnrollmentDaemonProfile(role, 'docker')).toBeNull();
      expect(validateEnrollmentDaemonProfile(role, 'nginx')).not.toBeNull();
      expect(
        validateRegisteredDaemonProfile(role, 'docker', ['managed_databases_v1', 'managed_storage_v1'])
      ).toBeNull();
      expect(
        validateRegisteredDaemonProfile(role, 'docker', [
          'managed_databases_v1',
          'managed_storage_v1',
          'docker_deployments_v1',
        ])
      ).toContain('conflicting');
    }
    expect(validateRegisteredDaemonProfile('storage', 'docker', ['managed_databases_v1'])).toContain('update');
  });
  it('requires docker-daemon identity during enrollment', () => {
    expect(validateEnrollmentDaemonProfile('builder', 'nginx')).toContain('docker-daemon');
    expect(validateEnrollmentDaemonProfile('builder', 'docker')).toBeNull();
  });

  it('accepts only the isolated builder capability set during registration', () => {
    expect(validateRegisteredDaemonProfile('builder', 'docker', ['docker_builder_profile_v1'])).toBeNull();
    expect(validateRegisteredDaemonProfile('builder', 'docker', ['docker_deployments_v1'])).toContain(
      'builder profile'
    );
    expect(
      validateRegisteredDaemonProfile('builder', 'docker', ['docker_builder_profile_v1', 'managed_databases_v1'])
    ).toContain('conflicting');
  });

  it('does not change legacy node admission rules', () => {
    expect(validateRegisteredDaemonProfile('docker', 'docker', ['docker_deployments_v1'])).toBeNull();
    expect(validateRegisteredDaemonProfile('databases', 'docker', ['managed_databases_v1'])).toBeNull();
  });
});
