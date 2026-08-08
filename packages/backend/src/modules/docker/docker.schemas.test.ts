import { describe, expect, it } from 'vitest';
import {
  ContainerCreateSchema,
  ContainerRecreateSchema,
  FileBrowseSchema,
  FileMoveSchema,
  FileUploadCompleteSchema,
  FileUploadInitSchema,
} from './docker.schemas.js';
import { DockerDeploymentDesiredConfigSchema } from './docker-deployment.schemas.js';

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
