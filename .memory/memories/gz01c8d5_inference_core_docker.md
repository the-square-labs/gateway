---
{
  "id": "gz01c8d5",
  "file_name": "gz01c8d5_inference_core_docker",
  "tags": [
    "docker-compose",
    "inference-core",
    "local-development",
    "model-discovery",
    "troubleshooting"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790155283819,
  "updated_at": 1790634432082
}
---
Verified local setup lesson: the managed inference core must be installed from a Compose-managed Gateway container. A bare `tsx` backend can show a stale seeded `ready` row with no container or sealed credentials; provider authorization then fails with `CORE_CREDENTIALS_MISSING`. For local manual testing, run Gateway in a Compose container with the Docker socket, stable Compose labels, and an internal service-network alias; it can reuse the dev Postgres and Redis services. After installation, the UI exposes live discovered provider models and auto-fills metadata such as display name, context window, input/output limits, auto-compaction, modalities, and capabilities. This was verified on September 28, 2026 with core `2.60.0-thesqlabs.3`.

To test local core changes: the local stack runs as Compose project `gateway-local` from `/tmp/gateway-local-app.compose.yml` plus `/tmp/gateway-local-app.localcore.compose.yml`, which pins `INFERENCE_CORE_DISTRIBUTION_IMAGE=inference-core:local-dev`. Build the core with `docker build --build-arg VERSION=local-dev -t inference-core:local-dev .`; the default `VERSION=dev` fails readiness with `core readiness version mismatch: expected local-dev, received dev`. Gateway recreates a missing core only through the Repair operation (startup reconciliation just marks it degraded), and Repair merely restarts a still-running container, so remove `gateway-local-inference-core` first (its state and secrets volumes survive), then press Repair in Settings > Inference. Verified September 29, 2026.
