---
{
  "id": "lvklfxgs",
  "file_name": "lvklfxgs_gateway_release_upgrade",
  "tags": [
    "docker-compose",
    "e2e",
    "gateway",
    "release",
    "upgrade",
    "v2.6.12"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786843016045,
  "updated_at": 1786843016045
}
---
For Gateway release preparation after v2.6.12, run `pnpm test:release-upgrade`. The harness uses a unique disposable Compose project, pulls the immutable v2.6.12 Gateway and relay images, builds or accepts amd64 candidate images, seeds representative ingress/Docker/folder/connector/settings state, replaces only app and relay, and asserts PostgreSQL/Redis plus a runner-owned workload keep their identities and restart counts. It verifies all eight candidate migrations 0116-0123 exactly once, including the 0116 Docker folder-assignment `ON DELETE SET NULL` FK contract, domain-to-ingress backfill, persisted state, API E2E, app/relay restart, health version, and exact cleanup. Real Cloudflare mutations and runtime proxy/container mutations require disposable external credentials and connected daemons and remain separate staging gates. A normal semver Gateway tag publishes Gateway, relay, database connector, and secure-link connector; because the bundle also changes the Docker daemon, coordinate a separate matching `vX.Y.Z-docker` tag.
