import { describe, expect, it } from 'vitest';
import { ContainerCreateSchema } from './docker.schemas.js';
import {
  assertNoReservedDockerLabelChanges,
  changedReservedDockerLabels,
  isReservedDockerLabel,
} from './docker-reserved-labels.js';

describe('reserved Docker labels', () => {
  it.each([
    'com.docker.compose.project',
    'com.docker.compose.service',
    'wiolett.gateway.deployment.managed',
    'wiolett.gateway.availability.managed',
    'wiolett.gateway.compose.sidecar',
    'net.wiolett.gateway.managed',
    'com.wiolett.gateway.managed-service',
    'gateway.sandbox',
  ])('reserves %s', (key) => {
    expect(isReservedDockerLabel(key)).toBe(true);
  });

  it('leaves ordinary labels alone', () => {
    expect(isReservedDockerLabel('traefik.enable')).toBe(false);
    expect(isReservedDockerLabel('com.example.team')).toBe(false);
    expect(isReservedDockerLabel('gateway.route')).toBe(false);
  });

  it('refuses a Compose project label on create: it would re-home the container out of its folder', () => {
    const parsed = ContainerCreateSchema.safeParse({
      image: 'nginx:alpine',
      folderId: '22222222-2222-4222-8222-222222222222',
      labels: { 'com.docker.compose.project': 'elsewhere', team: 'a' },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['labels'] });
    expect(ContainerCreateSchema.safeParse({ image: 'nginx:alpine', labels: { team: 'a' } }).success).toBe(true);
  });

  it('lets a recreate keep reserved labels unchanged but never add or change one', () => {
    const current = { 'wiolett.gateway.archive.image.reference': 'app:1', team: 'a' };
    expect(() =>
      assertNoReservedDockerLabelChanges({ 'wiolett.gateway.archive.image.reference': 'app:1', team: 'b' }, current)
    ).not.toThrow();
    expect(() => assertNoReservedDockerLabelChanges({ team: 'b' }, current)).not.toThrow();
    expect(changedReservedDockerLabels({ 'com.docker.compose.project': 'x' }, current)).toEqual([
      'com.docker.compose.project',
    ]);
    expect(() => assertNoReservedDockerLabelChanges({ 'wiolett.gateway.deployment.managed': 'true' }, current)).toThrow(
      /reserved/
    );
  });
});
