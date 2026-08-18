import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePageArchive } from './page-archive-validator.js';

interface TarEntry {
  name: string;
  data?: string | Buffer;
  type?: string;
  linkName?: string;
}

const tempDirs: string[] = [];
const limits = { maxFiles: 10, maxFileBytes: 1024, maxExpandedBytes: 4096, maxPathBytes: 255 };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`, 'ascii');
}

function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(data.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    if (entry.linkName) header.write(entry.linkName, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148);
    blocks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function writeArchive(entries: TarEntry[], mutate?: (archive: Buffer) => Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-pages-archive-'));
  tempDirs.push(dir);
  const path = join(dir, 'site.tar.gz');
  const archive = tar(entries);
  await writeFile(path, gzipSync(mutate ? mutate(archive) : archive));
  return path;
}

describe('validatePageArchive', () => {
  it('accepts a bounded static tar.gz without extracting it', async () => {
    const path = await writeArchive([
      { name: 'assets/', type: '5' },
      { name: 'index.html', data: '<h1>Hello</h1>' },
      { name: 'assets/app.js', data: 'console.log(1)' },
    ]);

    await expect(validatePageArchive(path, limits)).resolves.toEqual({ fileCount: 2, expandedSizeBytes: 28 });
  });

  it('accepts index.htm as the root entrypoint', async () => {
    const path = await writeArchive([{ name: 'index.htm', data: '<h1>Hello</h1>' }]);

    await expect(validatePageArchive(path, limits)).resolves.toEqual({ fileCount: 1, expandedSizeBytes: 14 });
  });

  it('requires the entrypoint at the archive root', async () => {
    const missing = await writeArchive([{ name: 'assets/app.js', data: 'console.log(1)' }]);
    const nested = await writeArchive([{ name: 'site/index.html', data: '<h1>Hello</h1>' }]);

    await expect(validatePageArchive(missing, limits)).rejects.toMatchObject({
      code: 'PAGES_ARCHIVE_ENTRYPOINT_MISSING',
    });
    await expect(validatePageArchive(nested, limits)).rejects.toMatchObject({
      code: 'PAGES_ARCHIVE_ENTRYPOINT_MISSING',
    });
  });

  it.each([
    ['parent traversal', [{ name: '../secret', data: 'x' }], 'PAGES_ARCHIVE_PATH_TRAVERSAL'],
    ['absolute path', [{ name: '/etc/passwd', data: 'x' }], 'PAGES_ARCHIVE_PATH_ABSOLUTE'],
    ['symlink', [{ name: 'link', type: '2', linkName: '/etc/passwd' }], 'PAGES_ARCHIVE_ENTRY_FORBIDDEN'],
    ['hardlink', [{ name: 'link', type: '1', linkName: 'index.html' }], 'PAGES_ARCHIVE_ENTRY_FORBIDDEN'],
    [
      'normalized duplicate',
      [
        { name: './index.html', data: 'one' },
        { name: 'index.html', data: 'two' },
      ],
      'PAGES_ARCHIVE_DUPLICATE_PATH',
    ],
    [
      'file used as parent',
      [
        { name: 'assets', data: 'file' },
        { name: 'assets/app.js', data: 'child' },
      ],
      'PAGES_ARCHIVE_PATH_CONFLICT',
    ],
    [
      'file replacing parent directory',
      [
        { name: 'assets/app.js', data: 'child' },
        { name: 'assets', data: 'file' },
      ],
      'PAGES_ARCHIVE_PATH_CONFLICT',
    ],
    ['control character', [{ name: 'bad\nname', data: 'x' }], 'PAGES_ARCHIVE_PATH_INVALID'],
  ])('rejects %s entries', async (_label, entries, code) => {
    const path = await writeArchive(entries as TarEntry[]);
    await expect(validatePageArchive(path, limits)).rejects.toMatchObject({ code });
  });

  it('rejects file-count, per-file, and total expanded-size overflow', async () => {
    const path = await writeArchive([
      { name: 'one', data: Buffer.alloc(700) },
      { name: 'two', data: Buffer.alloc(700) },
    ]);
    await expect(
      validatePageArchive(path, { ...limits, maxFiles: 1, maxFileBytes: 600, maxExpandedBytes: 1000 })
    ).rejects.toMatchObject({ code: 'PAGES_ARCHIVE_FILE_TOO_LARGE' });
    await expect(validatePageArchive(path, { ...limits, maxFiles: 1 })).rejects.toMatchObject({
      code: 'PAGES_ARCHIVE_TOO_MANY_FILES',
    });
    await expect(validatePageArchive(path, { ...limits, maxExpandedBytes: 1000 })).rejects.toMatchObject({
      code: 'PAGES_ARCHIVE_EXPANDED_TOO_LARGE',
    });
  });

  it('rejects corrupt headers and non-gzip input', async () => {
    const corrupt = await writeArchive([{ name: 'index.html', data: 'hello' }], (archive) => {
      archive[0] ^= 0xff;
      return archive;
    });
    await expect(validatePageArchive(corrupt, limits)).rejects.toMatchObject({
      code: 'PAGES_ARCHIVE_CHECKSUM_INVALID',
    });

    const dir = await mkdtemp(join(tmpdir(), 'gateway-pages-archive-'));
    tempDirs.push(dir);
    const invalid = join(dir, 'invalid.tar.gz');
    await writeFile(invalid, 'not gzip');
    await expect(validatePageArchive(invalid, limits)).rejects.toMatchObject({ code: 'PAGES_ARCHIVE_INVALID_GZIP' });
  });
});
