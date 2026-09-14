import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [version, image, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: bundle-backup-runner.mjs VERSION IMAGE OUTPUT');
if (!image) {
  if (/^v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version ?? '')) {
    throw new Error('Release images require a bundled immutable backup runner');
  }
} else {
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Backup runner must be digest-pinned');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ schemaVersion: 1, image }) + '\n');
}
