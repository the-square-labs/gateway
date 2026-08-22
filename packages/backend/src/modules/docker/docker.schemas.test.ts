import { describe, expect, it } from 'vitest';
import {
  ContainerCreateSchema,
  ContainerRecreateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
  VolumeCreateSchema,
} from './docker.schemas.js';
import { DockerDeploymentDesiredConfigSchema } from './docker-deployment.schemas.js';

describe('docker volume create schema', () => {
  it('defaults regular volumes and requires capacity only for disk images', () => {
    expect(VolumeCreateSchema.parse({ name: 'data' })).toEqual({ name: 'data', storageKind: 'regular' });
    expect(VolumeCreateSchema.safeParse({ name: 'bounded', storageKind: 'disk-image' }).success).toBe(false);
    expect(
      VolumeCreateSchema.safeParse({
        name: 'bounded',
        storageKind: 'disk-image',
        capacityBytes: 1024 ** 3,
      }).success
    ).toBe(true);
    expect(VolumeCreateSchema.safeParse({ name: 'data', capacityBytes: 1024 ** 3 }).success).toBe(false);
  });
});

describe('docker container create schemas', () => {
  it('requires exactly one mount source and absolute mount paths', () => {
    expect(
      ContainerCreateSchema.safeParse({ image: 'nginx:alpine', volumes: [{ containerPath: '/data' }] }).success
    ).toBe(false);
    expect(
      ContainerCreateSchema.safeParse({
        image: 'nginx:alpine',
        volumes: [{ hostPath: '/srv/data', name: 'data', containerPath: '/data' }],
      }).success
    ).toBe(false);
    expect(
      ContainerCreateSchema.safeParse({
        image: 'nginx:alpine',
        volumes: [{ name: 'data', containerPath: '/data', readOnly: true }],
      }).success
    ).toBe(true);
  });
});

describe('docker file path schemas', () => {
  it('accepts absolute file paths with dots inside a filename', () => {
    expect(FileBrowseSchema.parse({ path: '/tmp/file..txt' })).toEqual({ path: '/tmp/file..txt' });
  });

  it('rejects relative paths and parent traversal segments', () => {
    for (const schema of [FileBrowseSchema, FileUploadInitSchema, FileUploadCompleteSchema]) {
      expect(schema.safeParse({ path: '../file.txt', totalBytes: 0 }).success).toBe(false);
      expect(schema.safeParse({ path: '/../file.txt', totalBytes: 0 }).success).toBe(false);
      expect(schema.safeParse({ path: '/nested/../file.txt', totalBytes: 0 }).success).toBe(false);
    }
  });

  it('rejects parent traversal in move paths', () => {
    expect(FileMoveSchema.safeParse({ fromPath: '/../file.txt', toPath: '/safe.txt' }).success).toBe(false);
    expect(FileMoveSchema.safeParse({ fromPath: '/safe.txt', toPath: '/nested/../file.txt' }).success).toBe(false);
  });
});

describe('docker GPU selection schemas', () => {
  it('accepts an explicit device selection and an empty recreate selection for detach', () => {
    expect(
      ContainerCreateSchema.parse({ image: 'nvidia/cuda:latest', gpu: { deviceIds: ['nvidia:GPU-1'] } }).gpu
    ).toEqual({
      deviceIds: ['nvidia:GPU-1'],
    });
    expect(ContainerRecreateSchema.parse({ gpu: { deviceIds: [] } }).gpu).toEqual({ deviceIds: [] });
    expect(
      DockerDeploymentDesiredConfigSchema.parse({ image: 'nvidia/cuda:latest', gpu: { deviceIds: ['nvidia:GPU-1'] } })
        .gpu
    ).toEqual({ deviceIds: ['nvidia:GPU-1'] });
  });

  it('rejects duplicate IDs and arbitrary host-device payloads', () => {
    expect(
      ContainerCreateSchema.safeParse({
        image: 'nvidia/cuda:latest',
        gpu: { deviceIds: ['nvidia:GPU-1', 'nvidia:GPU-1'] },
      }).success
    ).toBe(false);
    expect(
      ContainerCreateSchema.safeParse({
        image: 'nvidia/cuda:latest',
        gpu: { deviceIds: ['nvidia:GPU-1'], devices: ['/dev/nvidia0'] },
      }).success
    ).toBe(false);
  });
});

describe('docker port binding schemas', () => {
  it('defaults legacy mappings to all interfaces and accepts a specific publish address', () => {
    expect(
      ContainerCreateSchema.parse({ image: 'nginx:alpine', ports: [{ hostPort: 8080, containerPort: 80 }] }).ports
    ).toEqual([{ hostPort: 8080, containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0' }]);
    expect(
      ContainerRecreateSchema.parse({
        ports: [{ hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
      }).ports
    ).toEqual([{ hostIp: '127.0.0.1', hostPort: 8080, containerPort: 80, protocol: 'tcp' }]);
  });

  it('rejects a non-IP publish address', () => {
    expect(
      ContainerRecreateSchema.safeParse({
        ports: [{ hostIp: 'docker-node.internal', hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
      }).success
    ).toBe(false);
  });

  it('rejects port numbers that the daemon uint16 contract cannot represent', () => {
    for (const ports of [
      [{ hostPort: -1, containerPort: 80 }],
      [{ hostPort: 8080.5, containerPort: 80 }],
      [{ hostPort: 8080, containerPort: 0 }],
      [{ hostPort: 8080, containerPort: 65536 }],
    ]) {
      expect(ContainerCreateSchema.safeParse({ image: 'nginx:alpine', ports }).success).toBe(false);
    }
  });
});
