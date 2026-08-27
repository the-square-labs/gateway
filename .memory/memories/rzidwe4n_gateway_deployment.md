---
{
  "id": "rzidwe4n",
  "file_name": "rzidwe4n_gateway_deployment",
  "tags": [
    "deployment",
    "e2e",
    "migration",
    "release",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785951397694,
  "updated_at": 1787862303230
}
---
Gateway Secure Link migration rules:

- Install compatible daemon versions before cutover and preserve node identities and stateful foundation services.
- Under the per-link migration lock, reread the proxy/link row before writing cutover state so stale snapshots cannot reset a completed or ready transition.
- Prove cutover by showing the old direct path is no longer required, while ensuring cleanup is automatically reversed after the test.
- During self-update, recreate the app before the relay where required and tolerate only bounded transient unhealthy states.
- Installer scripts fail closed when the requested daemon artifact cannot be downloaded; never retain a mismatched existing binary silently.
- Public proxy APIs expose only the stable `secureLinkActive` boolean and continue stripping internal Secure Link ports and status details.
- Release candidates use immutable digest references, and relay build identity must match the configured Gateway relay build version; otherwise supervision must report an image/contract mismatch.
- Migration verification must cover workload continuity, persisted database state, proxy behavior, node reconnect, and absence of unexpected workload restarts without persisting host-specific topology in memory.
