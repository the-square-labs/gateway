---
{
  "id": "j6oni2tm",
  "file_name": "j6oni2tm_gateway_compose_boundary",
  "tags": [
    "architecture",
    "compose",
    "docker",
    "documentation",
    "gateway",
    "licensing",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1787483483982,
  "updated_at": 1787532788311
}
---
# Gateway documentation and Docker Compose boundary

For future product, implementation, and documentation work:

- Pages is a shipped Ready capability on Personal, Business, and Enterprise. Preserve the current implementation and entitlement truth when editing broad capability documentation.
- Docker Compose support currently remains minimal runtime awareness through Docker labels/grouping and aggregated logs; this is not application orchestration.
- On August 24, 2026, a decision-complete implementation plan for first-class Compose Projects was accepted, but implementation has not started and the feature is not shipped. The active artifact is `.workflow/plans/08-24-26-first-class-compose-projects`.

Accepted first-class Compose Projects boundary:

- Compose Projects are a first-class Docker resource; do not introduce or depend on an Apps model.
- One ComposeProject entity has `managementState: external | managed`.
- External projects are discovered from Docker labels, read-only, and visible with Compose view RBAC without a Business license gate.
- External projects may be adopted only from a complete single Compose YAML supplied by the user. Gateway must not read host compose paths. The project remains external until the first apply succeeds.
- Managed create/adopt/lifecycle is Business-gated and uses `docker:compose:view/create/manage/delete`. Existing Docker folder-management permission controls Compose folders.
- Reuse existing Docker folders and UI shell/list/detail/editor/log/task patterns. Extract one reusable `ComposeLogsView` rather than adding another log transport.
- Compose-owned containers, named volumes, and non-external networks are hidden from global standalone lists and direct mutations are blocked server-side. Images and external/shared resources remain global.
- Daemon owns Compose execution through a typed Gateway protocol. Do not execute Compose in backend and do not depend on a host-installed `docker compose` CLI. Use the official embedded Compose SDK only if a bounded compatibility/cancellation/Engine-client spike passes; otherwise use a pinned daemon-owned sidecar behind the same protocol.
- Explicitly reject `build`, including `image + build`, because Gateway has no PaaS build workers. Also reject multi-file/override/include/extends, `env_file`, file configs/secrets, profiles/develop/replicas/scale, host binds, `docker.sock`, privileged/devices, and host network/pid/ipc.
- Accepted subset includes image-based services, environment interpolation, ports, healthcheck, depends_on, restart, named volumes, external volumes/networks, command/entrypoint/workdir/user/hostname, and safe labels.
- Revisions are immutable and drafts are not persisted. Ordinary apply does not force-pull present mutable tags; Pull & Apply is separate. Down preserves named volumes and deletion is separate. Reapplying an older revision is configuration rollback only. Drift is detected and shown, never auto-reconciled.
- Scope is single-node. Git deployment, build pipelines, scaling, migration, and multi-node scheduling are non-goals.

Documentation rule: until the plan is implemented and verified, continue describing Compose lifecycle as planned/in development rather than Ready.
