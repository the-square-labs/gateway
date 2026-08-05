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
  "created_at": 1785753898635,
  "updated_at": 1785753898635
}
---
The public Gateway installer is published under the vX.Y.Z-installer release tag as gateway-installer-linux-{amd64,arm64}.tar.gz. Each archive contains:
- bin/node: pinned Node runtime (24.18.0)
- app/cli.mjs: bundled @clack/prompts frontend
- bin/gateway-installer-engine: Go engine
- gateway-installer: launcher
External scripts included in the archive act only as checksum-verifying loaders.
Use gzip for the outer artifact (tar.gz) rather than xz because clean Ubuntu hosts may not have xz installed, while tar -xzf is generally available.
The Node frontend pre-fills copied flags and prompts only for missing values; selection of database storage happens on the target host.
The Go engine’s explicit parity matrix is located at packages/installer/PARITY.md. Do not claim complete legacy shell parity until that parity matrix is closed.
