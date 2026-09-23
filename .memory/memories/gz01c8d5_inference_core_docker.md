---
{
  "id": "gz01c8d5",
  "file_name": "gz01c8d5_inference_core_docker",
  "tags": [
    "dev-environment",
    "docker",
    "frontend",
    "inference"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1790155283819,
  "updated_at": 1790155283819
}
---
Verified on a local dev run of the Gateway backend outside Docker.

- The Providers and Models panels, and therefore the "Add inference model" dialog, stay hidden until isInferenceCoreReady() passes in packages/frontend/src/pages/settings/inference/InferenceCoreLifecyclePanel.tsx: inference_core_state.state must be 'ready' or 'update_available' and compatibility must be 'compatible'. Compatibility needs core_protocol_major = INFERENCE_CORE_PROTOCOL_MAJOR and core_state_schema_version = INFERENCE_CORE_STATE_SCHEMA_VERSION, both 1 as of 2026-09.
- Installing the inference core requires Gateway itself to run as a Compose-managed container. InferenceCoreRuntimeService.discoverLayout() calls DockerService.inspectSelf(), which reads process.env.HOSTNAME as the short container id, then demands the com.docker.compose.project and com.docker.compose.service labels plus a network alias equal to the service name. A bare tsx dev process fails with "HOSTNAME env var not available - cannot self-inspect", and setting HOSTNAME by hand does not help because the labels and alias are still missing.
- To exercise the dialog without a real provider account, insert an inference_provider_connections row (provider_id 'anthropic', auth_type 'oauth', status 'healthy') plus inference_discovered_models rows, and force inference_core_state into the ready/compatible shape above. Publishing additionally validates the published modalities and capabilities against the stored discovered row, so that row must carry what the catalog merge in persistModels would have written.
