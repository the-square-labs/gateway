---
{
  "id": "yfhytkcz",
  "file_name": "yfhytkcz_token_selector_fix",
  "tags": [
    "enrollment",
    "gateway",
    "grpc",
    "local-smoke",
    "security",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1782930153895,
  "updated_at": 1786067602781
}
---
Gateway WIO-23 fix pattern: node enrollment DoS risk was removed by issuing tokens as `gw_node_v2_<selector>_<secret>`, storing nullable `nodes.enrollment_token_selector` with an index, hashing the full token, and resolving v2 enrollment by selector with at most one bcrypt compare. Legacy compatibility should only accept the exact old `gw_node_<48 hex>` format; malformed `gw_node_*` inputs must be rejected before bcrypt so they cannot trigger legacy scans. Successful enrollment clears both selector and hash. Local smoke workflow: start backend with `PORT=3001 GRPC_PORT=9443 pnpm --dir packages/backend dev`, insert a pending node with a generated v2 token through the project's configured local PostgreSQL instance, call real gRPC `NodeEnrollment.Enroll` on `127.0.0.1:9443` using `certificate_authorities.is_system` PEM as root trust and `grpc.ssl_target_name_override=localhost`, verify status online + selector/hash null + cert serial set, then delete the smoke node and issued cert.
