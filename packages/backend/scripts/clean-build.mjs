import { rm } from 'node:fs/promises';

// Deleted commercial modules must not survive as stale JS/maps in a subsequent
// Community build. Only this package's generated output is removed.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
