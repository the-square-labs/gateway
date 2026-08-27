---
{
  "id": "z36pcfh4",
  "file_name": "z36pcfh4_inference_failover_routes",
  "tags": [
    "discovery",
    "failover",
    "gateway-inference",
    "routing",
    "v2.9.8"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787837324629,
  "updated_at": 1787837324629
}
---
Gateway Inference runtime routing contract after v2.9.8:

- The model administration UI account count represents persisted enabled source bindings. It is not proof that every binding survived the data-plane runtime eligibility query.
- In production, three OpenAI subscription bindings existed for gpt-5.6-sol/terra/luna, but two discovered-model rows were temporarily unavailable between provider sync cycles. `InferenceCoreProxyService.coreCandidates` filtered on `inference_discovered_models.available`, leaving only the 5%-remaining account at its 5% reserve and returning `provider_capacity_unavailable` despite two healthy high-capacity bindings.
- A configured, enabled, non-deleted, core-backed source must remain a routing candidate across transient discovery omissions. Discovery availability is catalog freshness, not authoritative request-time reachability. If the core/upstream rejects the model, the response-level failover path owns excluding that connection and trying the next candidate.
- Gateway v2.9.8 removes the discovery-availability predicate from core candidate selection. Keep capability compatibility, source/connection enablement, deletion, and core-link checks as hard filters.
- Verification: targeted core-proxy and routing tests, backend typecheck, scoped Biome, tag pipeline 1947, and release publication all passed. Production CT250 was intentionally not updated by Codex.
