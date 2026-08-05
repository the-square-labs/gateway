---
{
  "id": "kufbu8qt",
  "file_name": "kufbu8qt_gateway_release_workflow",
  "tags": [
    "deploy",
    "gateway",
    "gitlab-ci",
    "release",
    "signing",
    "tags"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.65,
  "importance": 0.75,
  "created_at": 1777245789774,
  "updated_at": 1784761702440
}
---
Gateway release workflow:
- GitLab CI uses annotated tags vX.Y.Z for Gateway image/backend/frontend releases.
- Daemons release independently with tags vX.Y.Z-nginx, vX.Y.Z-docker, and vX.Y.Z-monitoring; do not assume daemon versions match the Gateway version.
- Push main first, then push the intended annotated release tag. Tag pipeline rules are defined in .gitlab-ci.yml.
- Signed Gateway update manifests must contain the top-level OCI image digest. In the runner environment, extract the text Digest: line from docker buildx imagetools inspect; do not rely on --format '{{.Manifest.Digest}}' if it returns the full human-readable output.
- An invalid digest produces Gateway update verification errors such as Gateway update digest is invalid / UNTRUSTED_UPDATE_ARTIFACT. Historical v2.3.0 and v2.3.1 manifests had this defect; target a later fixed release rather than those manifests.
