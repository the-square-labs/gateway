import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export async function installPrivateRuntime(
  sourceFile: string,
  destinationFile: string
): Promise<{ updated: boolean; path: string }> {
  const source = await readFile(sourceFile);
  await mkdir(dirname(destinationFile), { recursive: true, mode: 0o700 });
  await installNativeKeyringPackage(dirname(destinationFile));
  let current: Buffer | undefined;
  try {
    current = await readFile(destinationFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current?.equals(source)) {
    await chmod(destinationFile, 0o700);
    return { updated: false, path: destinationFile };
  }

  const temporary = `${destinationFile}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(sourceFile, temporary, constants.COPYFILE_FICLONE);
  await chmod(temporary, 0o700);
  await rename(temporary, destinationFile);
  await chmod(destinationFile, 0o700);
  return { updated: true, path: destinationFile };
}

function resolveNativeKeyringPackage(): { name: string; entry: string; packageJson: string } {
  const packageName = nativeKeyringPackage();
  try {
    const keyringRequire = createRequire(require.resolve('@napi-rs/keyring/package.json'));
    return {
      name: packageName,
      entry: keyringRequire.resolve(packageName),
      packageJson: keyringRequire.resolve(`${packageName}/package.json`),
    };
  } catch (error) {
    throw new Error(`The platform credential-store binding ${packageName} is unavailable.`, { cause: error });
  }
}

async function installNativeKeyringPackage(runtimeDirectory: string): Promise<void> {
  const native = resolveNativeKeyringPackage();
  const [scope, packageName] = native.name.split('/');
  const packageDirectory = join(runtimeDirectory, 'node_modules', scope, packageName);
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await atomicCopy(native.entry, join(packageDirectory, basename(native.entry)), 0o600);
  await atomicCopy(native.packageJson, join(packageDirectory, 'package.json'), 0o600);
}

async function atomicCopy(source: string, destination: string, mode: number): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temporary, constants.COPYFILE_FICLONE);
  await chmod(temporary, mode);
  await rename(temporary, destination);
  await chmod(destination, mode);
}

function nativeKeyringPackage(): string {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
    return `@napi-rs/keyring-darwin-${process.arch}`;
  }
  if (process.platform === 'win32' && ['arm64', 'x64', 'ia32'].includes(process.arch)) {
    return `@napi-rs/keyring-win32-${process.arch}-msvc`;
  }
  if (process.platform === 'freebsd' && process.arch === 'x64') return '@napi-rs/keyring-freebsd-x64';
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const libc = report?.header?.glibcVersionRuntime ? 'gnu' : 'musl';
    if (['arm64', 'x64'].includes(process.arch)) return `@napi-rs/keyring-linux-${process.arch}-${libc}`;
    if (process.arch === 'riscv64' && libc === 'gnu') return '@napi-rs/keyring-linux-riscv64-gnu';
    if (process.arch === 'arm') return '@napi-rs/keyring-linux-arm-gnueabihf';
  }
  throw new Error(`The operating system credential store is unsupported on ${process.platform}/${process.arch}.`);
}
