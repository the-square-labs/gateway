---
{
  "id": "hqwh565e",
  "file_name": "hqwh565e_gateway_installer_node",
  "tags": [
    "cli",
    "gateway-installer",
    "node",
    "release"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.8,
  "created_at": 1785753898635,
  "updated_at": 1790812807380
}
---
Status (verified 2026-10-01): the bundled Go/Node "gateway-installer" described below shipped only in the v2.5.0 RC line (its commits are in tag v2.5.0-rc.9) and is NOT in main: there is no `packages/installer`, and `scripts/release-tag.sh` has no `-installer` component. Current installs use `scripts/install.sh` and the `scripts/setup-*-node.sh` scripts. Keep this only as history or if the owner revives the bundle.

Historical design: the public installer was published under a vX.Y.Z-installer release tag as gateway-installer-linux-{amd64,arm64}.tar.gz containing bin/node (pinned Node runtime 24.18.0), app/cli.mjs (bundled @clack/prompts frontend), bin/gateway-installer-engine (Go engine) and a gateway-installer launcher; external scripts were only checksum-verifying loaders. The Node frontend pre-filled copied flags and prompted only for missing values; database storage selection happened on the target host. The Go engine's parity matrix was packages/installer/PARITY.md; legacy shell parity was never claimed complete.

Reusable lesson: publish installer archives as gzip (tar.gz), not xz, because clean Ubuntu hosts may not have xz while `tar -xzf` is generally available.
