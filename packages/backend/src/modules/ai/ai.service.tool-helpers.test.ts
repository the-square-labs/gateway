import { describe, expect, it } from 'vitest';
import { approvalDisplayArgs, redactArgsForAudit } from './ai.service.tool-helpers.js';

describe('redactArgsForAudit', () => {
  it('keeps written file and Compose bodies out of audit rows, but not out of the approval prompt', () => {
    const fileWrite = {
      operation: 'write',
      nodeId: 'node-1',
      path: '/opt/app/.env',
      content: 'DB_PASSWORD=S3cr3t\nSTRIPE_SECRET_KEY=sk_live_abc\n',
    };
    expect(redactArgsForAudit('manage_node_file', fileWrite)).toEqual({
      operation: 'write',
      nodeId: 'node-1',
      path: '/opt/app/.env',
      content: { redacted: true, bytes: 49 },
    });
    expect(approvalDisplayArgs('manage_node_file', fileWrite).content).toBe(fileWrite.content);

    const compose = redactArgsForAudit('manage_docker_compose', {
      operation: 'revision_create',
      yaml: 'services:\n  app:\n    environment:\n      TOKEN: abc\n',
      files: [{ path: 'a.env', content: 'TOKEN=abc' }],
    });
    expect(JSON.stringify(compose)).not.toContain('abc');
  });

  it('bounds the arguments a large call stores', () => {
    const audited = redactArgsForAudit('gitlab_commit_files', {
      projectId: 'group/project',
      actions: Array.from({ length: 2000 }, (_, index) => ({ action: 'update', filePath: `src/file-${index}.ts` })),
    });
    expect(audited).toMatchObject({ projectId: 'group/project', argumentsTruncated: true });
    expect(JSON.stringify(audited).length).toBeLessThan(16 * 1024);
  });
});
