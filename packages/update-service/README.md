# Gateway update service

Cloudflare Worker for the stable public Gateway update namespace at
`updates.thesqlabs.com/gateway`.

It exposes:

- `GET /health`
- `GET /gateway/releases` (stable by default)
- `GET /gateway/releases?channel=stable|preview`
- `GET /gateway/releases?component=<package>&current=<version>&channel=stable|preview`
- `GET|HEAD /gateway/<package>/<tag>/<artifact>` for allow-listed signed Gateway artifacts

`stable` is the default and excludes GitHub prereleases. `preview` additionally accepts release-candidate tags such as `v2.10.0-rc.1`, `v2.10.0-rc.1-relay`, and matching daemon component tags. Component-aware requests return the newest patch on the current minor first, otherwise the baseline release of the next minor; no update returns `204` with `Cache-Control: no-store`. Inference Core ignores the requested channel and remains stable-only.

The Worker aggregates GitHub Releases from the public
`the-square-labs/gateway` repository and the private
`the-square-labs/inference-core` repository. It keeps the GitHub token only in
the `GITHUB_INFERENCE_CORE_TOKEN` Worker secret. The token provides private core
access and authenticated public Gateway API reads that avoid shared anonymous
rate limits. The service does not use R2. Release metadata is cached briefly,
while immutable release assets use long-lived edge caching.

```bash
pnpm --filter @sqgateway/update-service test
pnpm --filter @sqgateway/update-service typecheck
pnpm --filter @sqgateway/update-service build
```

Deployment uses the custom domain declared in `wrangler.jsonc`:

```bash
pnpm --filter @sqgateway/update-service deploy
```
