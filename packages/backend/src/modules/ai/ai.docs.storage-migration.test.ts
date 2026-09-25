import { describe, expect, it } from 'vitest';
import { DOC_TOPIC_SCOPES, getInternalDocumentation, INTERNAL_DOCS } from './ai.docs.js';
import { AI_TOOLS } from './ai.tools.js';

function actions(toolName: string): string[] {
  const tool = AI_TOOLS.find((candidate) => candidate.name === toolName);
  const properties = (tool?.parameters as { properties?: Record<string, { enum?: string[] }> } | undefined)?.properties;
  return properties?.action?.enum ?? properties?.operation?.enum ?? [];
}

describe('MinIO to SeaweedFS migration guide', () => {
  const guide = INTERNAL_DOCS['storage-migration']!;

  it('is a storage topic linked from the storage docs', () => {
    expect(DOC_TOPIC_SCOPES['storage-migration']).toBe('storage:view');
    expect(getInternalDocumentation('storage-migration', ['storage:view']).content).toContain(
      '# Migrating legacy MinIO'
    );
    expect(getInternalDocumentation('storage-migration', ['databases:view']).content).toContain(
      'do not have permission'
    );
    expect(INTERNAL_DOCS.storage).toContain('storage-migration');
  });

  it('names only actions the tools implement', () => {
    for (const action of [
      'move_binding',
      'import_access_keys',
      'freeze_writes',
      'unfreeze_writes',
      'rehome_backup_history',
    ]) {
      expect(actions('manage_managed_storage')).toContain(action);
      expect(guide).toContain(`\`${action}\``);
    }
    for (const action of ['copy_data_start', 'copy_data_status']) {
      expect(actions('manage_storage_connection')).toContain(action);
      expect(guide).toContain(action);
    }
    expect(actions('manage_additional_secure_link')).toContain('retarget');
    expect(guide).toContain('manage_additional_secure_link retarget');
  });

  it('keeps the safety rules: no MinIO recreate, no FTP/SFTP, no secrets in chat, verified copies', () => {
    expect(guide).toContain('Never `restart`, `update` or `retry` the MinIO cluster');
    expect(guide).toContain('no FTP and no SFTP');
    expect(guide).toContain('Never repeat root credentials or key secrets in chat');
    expect(guide).toContain('report.clean: true');
    for (const section of ['## Preflight', '## Cutover', '## Rollback', '## Retire']) expect(guide).toContain(section);
  });

  it('orders the cutover and rollback safely and names the result fields the agent must read', () => {
    const cutover = guide.slice(guide.indexOf('## Cutover'), guide.indexOf('## Rollback'));
    // Backups move (or pause) before the freeze.
    expect(cutover.indexOf('update_policy')).toBeLessThan(cutover.indexOf('`freeze_writes` on the source'));
    expect(guide).toContain('config: {jobId: <the id returned by copy_data_start>}');
    expect(guide).toContain('A clean report is required only for the final sync');
    expect(guide).toContain('`unmanagedKeys` is `null`');
    const rollback = guide.slice(guide.indexOf('## Rollback'), guide.indexOf('## Retire'));
    const order = [
      'Backups first',
      '`freeze_writes` the target',
      'from the target to the source',
      '`move_binding` every link back',
      '`rehome_backup_history`',
      '`unfreeze_writes` the source',
    ].map((step) => rollback.indexOf(step));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rollback).toContain('Gateway read-write policy');
  });
});
