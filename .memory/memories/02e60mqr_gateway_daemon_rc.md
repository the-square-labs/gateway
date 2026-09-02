---
{
  "id": "02e60mqr",
  "file_name": "02e60mqr_gateway_daemon_rc",
  "tags": [
    "daemon",
    "docker",
    "gateway",
    "github-actions",
    "rc",
    "relay",
    "release"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785765229346,
  "updated_at": 1788309567528
}
---
Gateway and daemon release conventions as verified from the current repository on 2026-09-02:

Versioning and tag classification
- scripts/release-tag.sh is authoritative.
- Gateway tags are vX.Y.Z and vX.Y.Z-rc.N.
- Component tags append the component after the complete Gateway version:
  - vX.Y.Z-relay or vX.Y.Z-rc.N-relay
  - vX.Y.Z-nginx or vX.Y.Z-rc.N-nginx
  - vX.Y.Z-docker or vX.Y.Z-rc.N-docker
  - vX.Y.Z-monitoring or vX.Y.Z-rc.N-monitoring
- Do not use vX.Y.Z-<component>-rc.N. That older ordering is not accepted by the current classifier.
- For a component tag, RELEASE_VERSION is the tag with the final component suffix removed. For example, v2.10.0-rc.28-docker embeds/signs v2.10.0-rc.28.

GitHub release order
- The repository remote is currently GitHub and releases run through .github/workflows/release.yml.
- Push main first and verify the local and remote SHA match.
- Wait for a successful push-triggered main CI run for the exact target SHA. Release verification rejects a tag when no successful main CI exists for that SHA.
- Push an annotated Gateway RC tag, wait for the release workflow to finish, and verify the published non-draft prerelease plus signed manifest and installer assets.
- Push only the component RC tags required by the changed binaries, then verify each component workflow and published assets.
- Do not equate a pushed tag with a completed release.

Component selection
- Backend/control-plane changes require a Gateway tag.
- Docker daemon code or its generated protobuf bindings require a Docker component tag.
- The relay is an opaque byte-level gRPC proxy for unknown services. A protobuf field added only to GatewayCommand does not by itself require a relay rebuild or relay tag when relay code and dependencies are unchanged.
- Preserve operational upgrade order backend, relay when changed, then daemons.

Release verification
- Confirm scripts/release-tag.sh classifies each candidate tag correctly.
- Run release metadata checks and the change-specific test/lint/typecheck/build gates.
- Confirm exact remote tag peeling to the intended commit.
- Confirm GitHub Actions success and inspect the published release assets.
- Production deployment remains separate from source push and release publication.

Compatibility loaders and signed artifacts
- Preserve curl-first and wget fallback behavior for installers.
- Gateway releases must publish a valid signed gateway-image.update.json containing the immutable OCI digest.
- Component releases must publish signed per-architecture update manifests, binaries, and checksums.
- Stable automatic-update behavior remains separate from prerelease/nightly selection.
