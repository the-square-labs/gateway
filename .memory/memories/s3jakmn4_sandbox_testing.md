---
{
  "id": "s3jakmn4",
  "file_name": "s3jakmn4_sandbox_testing",
  "tags": [
    "backend",
    "pnpm",
    "sandbox",
    "testing",
    "vitest"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790153367031,
  "updated_at": 1790153367031
}
---
Verified while testing a backend change in this monorepo (pnpm 9.15.0 workspace, nx, vitest 4):

- `pnpm install --frozen-lockfile --offline` fails because the local store lacks some tarballs (for example nx). A normal online `pnpm install --frozen-lockfile` succeeds; the ssh2 optional native crypto binding fails to compile on Node 26 and is harmless.
- Any `pnpm` invocation inside the sandbox aborts with "[ERROR] unable to open database file" because pnpm needs write access to ~/.local/share/pnpm. Run test binaries directly instead: `cd packages/backend && ./node_modules/.bin/vitest run <path>`, `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/biome check <paths>`.
- Three inference tests bind a real loopback server and fail in the sandbox with `listen EPERM 127.0.0.1`: inference-core-proxy.ws.integration.test.ts, inference-pinned-fetch.test.ts, and the "flushes keepalives over the real HTTP adapter" case in inference-core-proxy.service.test.ts. They pass when rerun outside the sandbox (~182 s, dominated by the keepalive/idle timers). Treat that EPERM as an environment limit, not a regression.
