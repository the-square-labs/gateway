import { describe, expect, it } from 'vitest';
import { CreateManagedDatabaseSchema, UpdateManagedDatabaseSchema } from './databases.schemas.js';

const create = {
  name: 'orders',
  type: 'postgres',
  version: '17',
  nodeId: '22222222-2222-4222-8222-222222222222',
  cpuCores: 1,
  memoryMb: 512,
};
const rule = 'Storage size is in GB from 0.1 to 16384 with at most one decimal place';

describe('managed database storage size', () => {
  it.each([0.1, 1.5, 2, 16_384])('takes %s GB at create and at resize', (storageSizeGb) => {
    expect(CreateManagedDatabaseSchema.safeParse({ ...create, storageSizeGb }).success).toBe(true);
    expect(UpdateManagedDatabaseSchema.safeParse({ storageSizeGb }).success).toBe(true);
  });

  it.each([0.05, 1.25, 0, 16_384.1])('refuses %s GB at create and at resize with the rule', (storageSizeGb) => {
    for (const result of [
      CreateManagedDatabaseSchema.safeParse({ ...create, storageSizeGb }),
      UpdateManagedDatabaseSchema.safeParse({ storageSizeGb }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toContain(rule);
    }
  });
});
