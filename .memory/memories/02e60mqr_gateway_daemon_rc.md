---
{
  "id": "02e60mqr",
  "file_name": "02e60mqr_gateway_daemon_rc",
  "tags": [
    "daemon",
    "downloader",
    "gitlab-ci",
    "installer",
    "rc",
    "releases"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.9,
  "importance": 0.8,
  "created_at": 1785765229346,
  "updated_at": 1785767925038
}
---
Gateway and daemon RC release conventions and verification

Tag formats and ordering
- Gateway RC tag format: vX.Y.Z-rc.N. This publishes the signed Gateway image manifest and the matching bundled installer archive without mutable image aliases. The shell loader downloads Gateway RC installers only with --nightly.
- Daemon RC tag format: vX.Y.Z-<daemon>-rc.N (examples: v2.5.0-nginx-rc.1, v2.5.0-docker-rc.1, v2.5.0-monitoring-rc.1). Do NOT use vX.Y.Z-rc.N-<daemon>. Gateways (old and new) select stable daemon releases only by tags ending in -nginx/-docker/-monitoring; suffix-middle RC tags are ignored by Gateway update checks.
- Publish the matching Gateway RC before publishing daemon RC tags because node --nightly downloads the latest Gateway RC installer. node --nightly resolves the latest matching daemon RC; --version accepts an exact full daemon RC tag.

CI and packaging behavior
- Daemon CI embeds vX.Y.Z-rc.N in the binary/signature manifest while the package/release tag remains vX.Y.Z-<daemon>-rc.N. Stable daemon tags, signed manifests, and normal automatic updates remain unchanged.

Installer compatibility and download behavior
- Compatibility loaders must try curl first and fall back to wget when curl is unavailable. This applies to archive checksum/download requests and the fallback paths in install.sh and all setup-*.sh wrappers. Maintain this behavior for minimal Ubuntu/LXC hosts.

Verification used
- bash scripts/test-gateway-installer-loader.sh (including a wget-only PATH)
- Go installer tests
- Targeted backend update tests plus typecheck
- CI YAML parse
- git diff --check
