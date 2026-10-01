---
{
  "id": "s3jakmn4",
  "file_name": "s3jakmn4_sandbox_testing",
  "tags": [
    "backend",
    "frontend",
    "node26",
    "pnpm",
    "sandbox",
    "testing",
    "vitest"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790153367031,
  "updated_at": 1790818819677
}
---
Sandbox gotchas when testing in this monorepo (pnpm workspace, nx, vitest 4), verified 2026-09-23 and re-checked against main on 2026-10-01:

- `pnpm install --frozen-lockfile --offline` fails because the local store lacks some tarballs (for example nx). A normal online `pnpm install --frozen-lockfile` succeeds; the ssh2 optional native crypto binding fails to compile on Node 26 and is harmless.
- Any `pnpm` invocation inside the agent sandbox aborts with "[ERROR] unable to open database file" because pnpm needs write access to ~/.local/share/pnpm. Run test binaries directly instead: `cd packages/backend && ./node_modules/.bin/vitest run <path>`, `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/biome check <paths>`. Do not run bare `npx biome` from the repo root: it installs an unrelated npm package named "biome".
- Tests that bind a real loopback server fail in the sandbox with `listen EPERM 127.0.0.1`; treat that as an environment limit, not a regression, and rerun outside the sandbox. On main after the 2026-09-29 light-suite cut the known one is `modules/inference/providers/inference-pinned-fetch.test.ts` (the former `inference-core-proxy.ws.integration.test.ts` and `inference-core-proxy.service.test.ts` were deleted).
- Frontend vitest on Node 26 fails every test in setup with "TypeError: Cannot read properties of undefined (reading 'clear')" at src/test/reset-stores.ts (`localStorage.clear()`): Node's built-in webstorage global shadows jsdom's localStorage. Run with `NODE_OPTIONS=--no-experimental-webstorage`. Environment issue, not a regression.
- A sandboxed vitest run can also silently skip whole files (crashed workers are reported under "Errors", not as failures), so the pre-push `pnpm test` must run unsandboxed and failures must be read by name.
- Heavy suites and builds belong on the build server, not the development Mac (owner's rule since 2026-09-29).
