import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  addManagedDatabaseBindingToYaml,
  assertManagedDatabaseBindingInYaml,
  composeBindingSecretKey,
  decodeComposeServiceTarget,
  encodeComposeServiceTarget,
  removeManagedDatabaseBindingFromYaml,
} from './compose-managed-bindings.js';

const bindingId = '55555555-5555-4555-8555-555555555555';
const target = {
  projectId: '44444444-4444-4444-8444-444444444444',
  serviceName: 'api/v2',
};
const patch = {
  bindingId,
  networkName: 'gateway-db-5555555555554555',
  environment: {
    DATABASE_URL: 'postgresql://example',
    DATABASE_PASSWORD: 'secret',
  },
};

describe('Compose managed bindings', () => {
  it('round-trips stable Compose service target identifiers', () => {
    expect(decodeComposeServiceTarget(encodeComposeServiceTarget(target))).toEqual(target);
  });

  it('adds secret placeholders and an external network to a service', () => {
    const result = addManagedDatabaseBindingToYaml(
      `name: storefront
services:
  api:
    image: example/api:1
    environment:
      EXISTING: value
    networks:
      - default
`,
      'api',
      patch
    );
    const document = parse(result.yaml) as any;
    expect(document.services.api.environment).toMatchObject({
      EXISTING: 'value',
      DATABASE_URL: `\${${composeBindingSecretKey(bindingId, 'DATABASE_URL')}}`,
      DATABASE_PASSWORD: `\${${composeBindingSecretKey(bindingId, 'DATABASE_PASSWORD')}}`,
    });
    expect(document.services.api.networks).toHaveProperty('default');
    expect(document.services.api.networks).toHaveProperty('gateway_db_5555555555554555');
    expect(document.networks.gateway_db_5555555555554555).toEqual({
      external: true,
      name: patch.networkName,
    });
    expect(() => assertManagedDatabaseBindingInYaml(result.yaml, 'api', patch)).not.toThrow();
  });

  it('removes only the exact managed placeholders and network', () => {
    const added = addManagedDatabaseBindingToYaml(
      `name: storefront
services:
  api:
    image: example/api:1
    environment:
      EXISTING: value
`,
      'api',
      patch
    );
    const removed = removeManagedDatabaseBindingFromYaml(added.yaml, 'api', patch);
    const document = parse(removed.yaml) as any;
    expect(document.services.api.environment).toEqual({ EXISTING: 'value' });
    expect(document.services.api.networks).toBeUndefined();
    expect(document.networks).toBeUndefined();
  });

  it('fails closed when a managed value was edited', () => {
    const added = addManagedDatabaseBindingToYaml(
      `name: storefront
services:
  api:
    image: example/api:1
`,
      'api',
      patch
    );
    const edited = added.yaml.replace(`\${${composeBindingSecretKey(bindingId, 'DATABASE_URL')}}`, 'manual-value');
    expect(() => removeManagedDatabaseBindingFromYaml(edited, 'api', patch)).toThrow('Managed environment');
  });
});
