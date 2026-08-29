import { describe, expect, it } from 'vitest';
import {
  addManagedDatabaseBindingToYaml,
  assertManagedDatabaseBindingInYaml,
  removeManagedDatabaseBindingFromYaml,
} from '@/modules/docker/compose/compose-managed-bindings.js';

const patch = {
  bindingId: '55555555-5555-4555-8555-555555555555',
  networkName: 'gateway-db-5555555555554555',
  hostAlias: 'db-5555555555554555',
  hostAddress: '172.28.0.1',
  environment: { DATABASE_URL: 'postgresql://binding:secret@db-5555555555554555:5432/app' },
};

describe('Compose managed database listener mapping', () => {
  it('adds and validates the daemon gateway alias with the managed network', () => {
    const added = addManagedDatabaseBindingToYaml('services:\n  api:\n    image: example/api:latest\n', 'api', patch);
    expect(added.yaml).toContain('db-5555555555554555: 172.28.0.1');
    expect(() => assertManagedDatabaseBindingInYaml(added.yaml, 'api', patch)).not.toThrow();
  });

  it('removes only the binding-owned alias and preserves unrelated extra hosts', () => {
    const source = `services:
  api:
    image: example/api:latest
    extra_hosts:
      internal.example: 192.0.2.10
`;
    const added = addManagedDatabaseBindingToYaml(source, 'api', patch);
    const removed = removeManagedDatabaseBindingFromYaml(added.yaml, 'api', patch);
    expect(removed.yaml).toContain('internal.example: 192.0.2.10');
    expect(removed.yaml).not.toContain('db-5555555555554555');
  });

  it('fails closed when a user changes the managed alias', () => {
    const added = addManagedDatabaseBindingToYaml('services:\n  api:\n    image: example/api:latest\n', 'api', patch);
    const changed = added.yaml.replace('172.28.0.1', '172.28.0.254');
    expect(() => assertManagedDatabaseBindingInYaml(changed, 'api', patch)).toThrow('managed host');
    expect(() => removeManagedDatabaseBindingFromYaml(changed, 'api', patch)).toThrow('Managed host');
  });
});
