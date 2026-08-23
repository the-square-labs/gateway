---
{
  "id": "j6oni2tm",
  "file_name": "j6oni2tm_gateway_compose_boundary",
  "tags": [
    "compose",
    "documentation",
    "licensing",
    "pages",
    "relay",
    "wiki"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787483483982,
  "updated_at": 1787483483982
}
---
# Gateway documentation reality baseline (2026-08-23)

For future documentation audits and product claims:

- Pages is a shipped Ready capability on Personal, Business, and Enterprise. Current implementation includes runtime routes, entitlement gates, navigation, nginx capability handling, deployment, retention, runtime configuration, placement, and migration; do not revive older BETA wording without fresh implementation evidence.
- The installed long-lived relay is the sole public owner of `9443/tcp`; the Gateway app's gRPC listener is internal. Relay/Relay Pool is a first-class product/data-plane service and should appear in service inventories, topology, deployment, security, node, and update documentation.
- Current Docker Compose support is limited to recognizing canonical Compose labels, protected project grouping, and aggregated log streaming. Compose-managed resources cannot use Gateway cross-node migration. This is not Gateway-managed Compose application deployment.
- Horizontal application clusters across multiple Docker nodes, multiple managed instances of one workload on one machine, and Compose application deployment/lifecycle are documentation-only roadmap entries: In development for Business and Enterprise, not shipped and not present in current runtime entitlement constants.
- Keep public claims synchronized across all three root READMEs, `docs/capabilities.md`, `docs/licensing.md`, relevant operator/developer/security guides, `packages/backend/src/modules/ai/ai.docs.ts`, and the bilingual GitLab Wiki. Separate existing multi-node inventory/migration/blue-green behavior from unreleased application orchestration.
- The GitLab Wiki synchronization commit for this audit is `9932c03`.
