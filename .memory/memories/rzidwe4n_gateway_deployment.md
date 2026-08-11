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
  "importance": 0.95,
  "created_at": 1785951397694,
  "updated_at": 1786459803428
}
---
On 2026-08-11, a clean-room v2.5.2 -> HEAD migration was exercised on Gateway host 172.20.0.140 with Docker node .136 and Nginx node .137. Install v2.5.2 daemons first, preserve node identities, then update to HEAD. A real legacy docker_container Alias Link migrated to Secure Link generation 2 active; Nginx switched from direct 172.20.0.136:18082 to loopback listener 127.0.0.1:41419. Strong proof: temporarily reject .137 -> .136:18082 with iptables; direct path failed while the proxy still returned C:ok, then remove the rule via trap. PostgreSQL, Redis, and workload container IDs were preserved, workload restarts remained 0, and both nodes were online on HEAD. Important fixes: reread the proxy row inside the per-link migration lock so stale state cannot reset cutover_ready; force-recreate app before relay during update and tolerate transient unhealthy checks; installer scripts must fail closed when the requested daemon artifact cannot be downloaded rather than keep a mismatched existing binary. Public proxy API should expose only secureLinkActive:boolean and continue stripping internal Secure Link ports/status; UI may render a Secure Link badge from that boolean. Release-like local images must use immutable digest refs and a relay binary whose buildVersion matches GATEWAY_RELAY_BUILD_VERSION, otherwise the relay supervisor correctly reports unexpected_image or contract_mismatch.
