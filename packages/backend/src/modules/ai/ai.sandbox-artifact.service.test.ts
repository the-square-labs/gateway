import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_TOOL_OUTPUT_CONVERSATION_MAX_BYTES,
  AI_TOOL_OUTPUT_MAX_BYTES,
  AISandboxArtifactService,
} from './ai.sandbox-artifact.service.js';

describe('AISandboxArtifactService', () => {
  let tempDir = '';
  let service: AISandboxArtifactService;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-sandbox-artifacts-test-'));
    service = new AISandboxArtifactService({
      AI_SANDBOX_ARTIFACT_DIR: tempDir,
    } as never);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('stores artifacts on disk, gates downloads by owner, and cleans orphaned files', async () => {
    const tempFilePath = path.join(tempDir, 'source.tmp');
    await writeFile(tempFilePath, 'artifact-body');

    const artifact = await service.saveFromTempFile({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceProcessId: 'process-1',
      sourcePath: 'result.txt',
      filename: 'result.txt',
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength('artifact-body'),
      tempFilePath,
    });

    expect(artifact.downloadUrl).toBe(`/api/ai/sandbox/artifacts/${artifact.id}/download`);
    const download = await service.getDownload('user-1', artifact.id);
    expect(await readFile(download.filePath, 'utf8')).toBe('artifact-body');
    await expect(service.getDownload('user-2', artifact.id)).rejects.toMatchObject({ statusCode: 403 });
    const listed = await service.listForUser('user-1');
    expect(listed).toMatchObject([
      {
        id: artifact.id,
        filename: 'result.txt',
        conversationId: 'conversation-1',
        downloadUrl: `/api/ai/sandbox/artifacts/${artifact.id}/download`,
      },
    ]);
    expect(listed[0]).not.toHaveProperty('expiresAt');

    const metaPath = path.join(tempDir, `${artifact.id}.json`);
    const metadata = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
    metadata.conversationId = null;
    await writeFile(metaPath, JSON.stringify(metadata));

    const orphanedStats = await service.getOrphanedStats();
    expect(orphanedStats).toEqual({
      count: 1,
      totalSizeBytes: Buffer.byteLength('artifact-body'),
    });

    const cleaned = await service.cleanOrphanedArtifacts();
    expect(cleaned.itemsCleaned).toBe(1);
    expect(cleaned.spaceFreedBytes).toBe(Buffer.byteLength('artifact-body'));
    await expect(stat(download.filePath)).rejects.toThrow();
    await expect(service.getDownload('user-1', artifact.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('deletes artifacts for a conversation', async () => {
    const firstTemp = path.join(tempDir, 'first.tmp');
    const secondTemp = path.join(tempDir, 'second.tmp');
    await writeFile(firstTemp, 'first-body');
    await writeFile(secondTemp, 'second-body');

    const first = await service.saveFromTempFile({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceProcessId: 'process-1',
      sourcePath: 'first.txt',
      filename: 'first.txt',
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength('first-body'),
      tempFilePath: firstTemp,
    });
    const second = await service.saveFromTempFile({
      userId: 'user-1',
      conversationId: 'conversation-2',
      sourceProcessId: 'process-2',
      sourcePath: 'second.txt',
      filename: 'second.txt',
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength('second-body'),
      tempFilePath: secondTemp,
    });

    const result = await service.deleteForConversation('user-1', 'conversation-1');
    expect(result.itemsDeleted).toBe(1);
    expect(result.spaceFreedBytes).toBe(Buffer.byteLength('first-body'));
    await expect(service.getDownload('user-1', first.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.getDownload('user-1', second.id)).toBeTruthy();
  });

  it('syncs conversation artifacts and makes removed chat images orphaned for housekeeping', async () => {
    const kept = await service.saveFromBuffer({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceProcessId: 'chat-upload',
      sourcePath: 'kept.png',
      filename: 'kept.png',
      mediaType: 'image/png',
      buffer: Buffer.from('kept-image'),
    });
    const removed = await service.saveFromBuffer({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceProcessId: 'chat-upload',
      sourcePath: 'removed.png',
      filename: 'removed.png',
      mediaType: 'image/png',
      buffer: Buffer.from('removed-image'),
    });
    const newlyUploaded = await service.saveFromBuffer({
      userId: 'user-1',
      conversationId: null,
      sourceProcessId: 'chat-upload',
      sourcePath: 'new.png',
      filename: 'new.png',
      mediaType: 'image/png',
      buffer: Buffer.from('new-image'),
    });
    const otherConversation = await service.saveFromBuffer({
      userId: 'user-1',
      conversationId: 'conversation-2',
      sourceProcessId: 'chat-upload',
      sourcePath: 'other.png',
      filename: 'other.png',
      mediaType: 'image/png',
      buffer: Buffer.from('other-image'),
    });

    await service.syncConversationArtifacts('user-1', [kept.id, newlyUploaded.id], 'conversation-1');

    const listed = await service.listForUser('user-1');
    expect(listed.find((artifact) => artifact.id === kept.id)?.conversationId).toBe('conversation-1');
    expect(listed.find((artifact) => artifact.id === newlyUploaded.id)?.conversationId).toBe('conversation-1');
    expect(listed.find((artifact) => artifact.id === removed.id)?.conversationId).toBeNull();
    expect(listed.find((artifact) => artifact.id === otherConversation.id)?.conversationId).toBe('conversation-2');

    const orphanedStats = await service.getOrphanedStats();
    expect(orphanedStats).toEqual({
      count: 1,
      totalSizeBytes: Buffer.byteLength('removed-image'),
    });

    const cleaned = await service.cleanOrphanedArtifacts();
    expect(cleaned.itemsCleaned).toBe(1);
    await expect(service.getDownload('user-1', removed.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.getDownload('user-1', kept.id)).toBeTruthy();
    expect(await service.getDownload('user-1', newlyUploaded.id)).toBeTruthy();
    expect(await service.getDownload('user-1', otherConversation.id)).toBeTruthy();
  });

  it('stores, pages, and searches conversation-owned tool outputs without exposing them cross-owner', async () => {
    const descriptor = await service.saveToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceRunId: 'run-1',
      sourceToolCallId: 'call-1',
      format: 'text',
      estimatedTokens: 12,
      preview: 'Alpha beta',
      buffer: Buffer.from('Alpha beta\nsecond ALPHA\nlast'),
    });

    expect(descriptor).toMatchObject({
      outputOffloaded: true,
      format: 'text',
      readTool: 'read_tool_output',
      searchTool: 'search_tool_output',
    });
    const first = await service.readToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      artifactId: descriptor.artifactId,
      limitBytes: 10,
    });
    expect(first).toMatchObject({ content: 'Alpha beta', offset: 0, nextOffset: 10, eof: false });
    const second = await service.readToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      artifactId: descriptor.artifactId,
      offset: first.nextOffset,
    });
    expect(second.content).toContain('second ALPHA');
    expect(second.eof).toBe(true);

    const search = await service.searchToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      artifactId: descriptor.artifactId,
      query: 'alpha',
    });
    expect(search.matches).toHaveLength(2);
    await expect(
      service.readToolOutput({
        userId: 'user-2',
        conversationId: 'conversation-1',
        artifactId: descriptor.artifactId,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.readToolOutput({
        userId: 'user-1',
        conversationId: 'conversation-2',
        artifactId: descriptor.artifactId,
      })
    ).rejects.toMatchObject({ statusCode: 403 });

    await service.syncConversationArtifacts('user-1', [], 'conversation-1');
    expect(
      (await service.listForUser('user-1')).find((item) => item.id === descriptor.artifactId)?.conversationId
    ).toBe('conversation-1');
  });

  it('accepts the 50 MB boundary and rejects larger automatic tool outputs', async () => {
    const below = await service.saveToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceRunId: 'run-1',
      sourceToolCallId: 'call-below',
      format: 'text',
      estimatedTokens: 1,
      preview: '',
      buffer: Buffer.alloc(AI_TOOL_OUTPUT_MAX_BYTES - 1024 * 1024),
    });
    expect(below.sizeBytes).toBe(49 * 1024 * 1024);
    await service.delete('user-1', below.artifactId);

    const exact = await service.saveToolOutput({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceRunId: 'run-1',
      sourceToolCallId: 'call-exact',
      format: 'text',
      estimatedTokens: 1,
      preview: '',
      buffer: Buffer.alloc(AI_TOOL_OUTPUT_MAX_BYTES),
    });
    expect(exact.sizeBytes).toBe(AI_TOOL_OUTPUT_MAX_BYTES);

    await expect(
      service.saveToolOutput({
        userId: 'user-1',
        conversationId: 'conversation-1',
        sourceRunId: 'run-1',
        sourceToolCallId: 'call-over',
        format: 'text',
        estimatedTokens: 1,
        preview: '',
        buffer: Buffer.alloc(AI_TOOL_OUTPUT_MAX_BYTES + 1),
      })
    ).rejects.toMatchObject({ code: 'TOOL_OUTPUT_TOO_LARGE', statusCode: 413 });
  });

  it('serializes concurrent quota reservations so only the request within 250 MB succeeds', async () => {
    const existingId = randomUUID();
    const existingSize = AI_TOOL_OUTPUT_CONVERSATION_MAX_BYTES - 1024;
    const existingPath = path.join(tempDir, `${existingId}.bin`);
    await writeFile(existingPath, '');
    await truncate(existingPath, existingSize);
    await writeFile(
      path.join(tempDir, `${existingId}.json`),
      JSON.stringify({
        id: existingId,
        userId: 'user-1',
        conversationId: 'conversation-1',
        kind: 'tool_output',
        sourceProcessId: 'run-old',
        sourcePath: 'old.txt',
        filename: 'old.txt',
        mediaType: 'text/plain',
        sizeBytes: existingSize,
        createdAt: new Date().toISOString(),
      })
    );

    const attempts = await Promise.allSettled(
      ['call-a', 'call-b'].map((sourceToolCallId) =>
        service.saveToolOutput({
          userId: 'user-1',
          conversationId: 'conversation-1',
          sourceRunId: 'run-1',
          sourceToolCallId,
          format: 'text',
          estimatedTokens: 1,
          preview: '',
          buffer: Buffer.alloc(1024),
        })
      )
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(attempts.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'TOOL_OUTPUT_ARTIFACT_QUOTA_EXCEEDED' },
    });
  });

  it('cleans interrupted temporary tool-output files', async () => {
    const partialPath = path.join(tempDir, `${randomUUID()}.tmp`);
    await writeFile(partialPath, 'partial');
    const cleaned = await service.cleanOrphanedArtifacts();
    expect(cleaned).toMatchObject({ itemsCleaned: 1, spaceFreedBytes: 7 });
    await expect(stat(partialPath)).rejects.toThrow();
  });

  it('uses a writable local artifact directory for the production default outside production', async () => {
    const localService = new AISandboxArtifactService({
      NODE_ENV: 'development',
      AI_SANDBOX_ARTIFACT_DIR: '/var/lib/gateway/ai-artifacts',
    } as never);
    const tempFilePath = path.join(tempDir, 'local-default-source.tmp');
    await writeFile(tempFilePath, 'local-artifact-body');

    const artifact = await localService.saveFromTempFile({
      userId: 'user-1',
      conversationId: 'conversation-1',
      sourceProcessId: 'process-1',
      sourcePath: 'result.txt',
      filename: 'result.txt',
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength('local-artifact-body'),
      tempFilePath,
    });

    const download = await localService.getDownload('user-1', artifact.id);
    expect(download.filePath).toContain(path.join(os.tmpdir(), 'gateway-ai-artifacts'));
    expect(await readFile(download.filePath, 'utf8')).toBe('local-artifact-body');

    await rm(download.filePath, { force: true });
    await rm(path.join(path.dirname(download.filePath), `${artifact.id}.json`), { force: true });
  });
});
