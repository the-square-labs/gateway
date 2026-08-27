# Gateway update service

Cloudflare Worker for the stable public Gateway update namespace at
`updates.thesqlabs.com/gateway`.

It exposes:

- `GET /health`
- `GET /gateway/releases`
- `GET|HEAD /gateway/<package>/<tag>/<artifact>` for allow-listed signed Gateway artifacts

The Worker aggregates GitHub Releases from the public
`the-square-labs/gateway` repository and the private
`the-square-labs/inference-core` repository. It stores private-repository access
only in the `GITHUB_INFERENCE_CORE_TOKEN` Worker secret and does not use R2.
Release metadata is cached briefly, while immutable release assets use
long-lived edge caching.

```bash
pnpm --filter @sqgateway/update-service test
pnpm --filter @sqgateway/update-service typecheck
pnpm --filter @sqgateway/update-service build
```

Deployment uses the custom domain declared in `wrangler.jsonc`:

```bash
pnpm --filter @sqgateway/update-service deploy
```
