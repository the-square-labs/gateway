import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectCliInvocation } from './cli.js';
import { installPrivateRuntime } from './runtime.js';

describe('private runtime installation', () => {
  it('atomically installs and updates a private executable without PATH changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-runtime-'));
    const source = join(directory, 'source.js');
    const destination = join(directory, 'private', 'gateway-cli.js');
    await writeFile(source, '#!/usr/bin/env node\nconsole.log("one")\n');
    expect(await installPrivateRuntime(source, destination)).toEqual({ updated: true, path: destination });
    expect(await installPrivateRuntime(source, destination)).toEqual({ updated: false, path: destination });
    await writeFile(source, '#!/usr/bin/env node\nconsole.log("two")\n');
    expect((await installPrivateRuntime(source, destination)).updated).toBe(true);
    expect(await readFile(destination, 'utf8')).toContain('two');
    const nativePackage = process.platform === 'darwin' ? `keyring-darwin-${process.arch}` : undefined;
    if (nativePackage) {
      await expect(
        access(join(directory, 'private', 'node_modules', '@napi-rs', nativePackage, 'package.json'))
      ).resolves.toBeUndefined();
    }
    if (process.platform !== 'win32') expect((await stat(destination)).mode & 0o777).toBe(0o700);
  });

  it('recognizes a private runtime invoked through a symlinked parent path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-cli-entry-'));
    const realDirectory = join(directory, 'real');
    const linkedDirectory = join(directory, 'linked');
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory, 'dir');
    const realEntry = join(realDirectory, 'gateway-cli.js');
    await writeFile(realEntry, '');

    expect(isDirectCliInvocation(pathToFileURL(realEntry).href, join(linkedDirectory, 'gateway-cli.js'))).toBe(true);
  });
});
