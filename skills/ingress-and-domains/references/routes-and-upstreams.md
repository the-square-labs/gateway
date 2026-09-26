# Routes and upstreams

## Domains

- `create_domain({ domain, nginxNodeId })` needs `domains:create`. `nginxNodeId` may be omitted only when exactly one nginx Node has a detected public address.
- With a Cloudflare connector, `create_domain` returns conflict metadata when different A/AAAA records already exist. Overwrite or adopt only after explicit user approval.
- `manage_domain({ operation: "check_dns", domainId })` re-checks resolution.
- A Domain used by a Route cannot be deleted until it is removed from those Routes; `isSystem` Domains cannot be deleted.

## create_route fields

- `nodeId` (required Ingress Node), `domainNames`, type `proxy`, `redirect`, or `404`.
- Proxy target: `forwardHost`, `forwardPort`, `forwardScheme`, and `upstreamKind` (`manual`, `docker_container`, `docker_deployment`, or `pages`).
- TLS: `sslEnabled`, `sslCertificateId` (an SSL certificate ID, never a PKI certificate ID), `sslForced`, `http2Support`.
- Behavior: `websocketSupport`, `accessListId`, `healthCheckEnabled`, `folderId`, `nginxTemplateId`.

## Upstream shapes

| Target | Fields |
| --- | --- |
| Standalone Container | `upstreamKind: "docker_container"`, `dockerNodeId`, `dockerContainerName`, `dockerContainerPort` |
| Compose service | `upstreamKind: "docker_container"`, `dockerNodeId`, `dockerComposeProjectId`, `dockerComposeServiceName`, `dockerContainerPort` (no Container name) |
| Blue/green Deployment | `upstreamKind: "docker_deployment"`, `dockerNodeId`, `dockerDeploymentId`, `dockerContainerPort` |
| Pages | `upstreamKind: "pages"`, `pageProjectId`, `pageTagId` of a ready Tag |
| Manual | `upstreamKind: "manual"`, `forwardHost`, `forwardPort`, `forwardScheme` |

A workload with Docker Availability is routed through its logical identity; Gateway balances across healthy placements (see `high-availability`).

## Other Route tools

- `get_route`, `update_route`, `delete_route` (does not delete its certificate or Access List), `list_routes`, `create_route_folder`, `move_routes_to_folder`, `delete_route_folder`, `resync_tls_distribution`.
- `manage_route` reads: `get_config`, `get_by_slug`, `health_history`, `secure_link_status`, `access_logs` (tail up to 200 lines), `maintenance_access_code` (a 5-minute bypass code, needs `proxy:maintenance:bypass`), and `validate_config`, which dry-checks an advanced snippet or, with `mode: "raw"`, a full raw config. Validate before switching a Route to raw mode or applying an unusual snippet.

## Additional Routes and Secure Links

- `manage_additional_route` manages path-prefix locations inside a Route: `list`, `get`, `create`, `update`, `retry`, `delete`, with `routeId`, `path`, and `targetKind` (`manual`, `docker_container`, `docker_deployment`, or `pages`). Docker and Compose targets create and own a route-owned Secure Link; change or delete it through the Additional Route.
- `manage_additional_secure_link` manages standalone bindings referenced from a Route's advanced nginx config: Docker destinations (`upstreamKind: "docker_container"` or `"docker_deployment"`) or a managed-storage S3 destination (`upstreamKind: "managed_storage"` with `managedStorageId`, reached over the private relay without a shared Docker network or published port). `retarget` moves a binding to another destination. Route-owned bindings appear in its `list` but change only through `manage_additional_route`.

## Raw config and templates

- `get_route_rendered_config` shows the generated server block.
- `toggle_route_raw_mode` and `update_route_raw_config` bypass template rendering and need `proxy:raw:write`; `proxy:unrestricted` also skips dangerous-directive validation. Both are high risk and OAuth manual-approval scopes.
- `list_routes` and `get_route` omit `rawConfig`; reading it needs raw-read permission.
- `manage_proxy_template` manages reusable nginx server-block templates (`proxy`, `redirect`, `404`; `{{variable}}` syntax), assigned through `nginxTemplateId`.

## Scopes

`domains:view|create|edit|delete|folders:manage`, `proxy:view|create|edit|delete|raw:read|raw:write|advanced|unrestricted|maintenance:bypass|folders:manage`, `proxy:templates:view|manage`, `ssl:cert:view|issue|delete|folders:manage`, `acl:view|create|edit|delete`. `ssl:cert:issue`, `ssl:cert:delete`, `proxy:raw:write`, `proxy:unrestricted`, and `proxy:templates:manage` need explicit OAuth approval. Full table: [Scopes reference](https://docs.goodgateway.dev/en/identity/scopes-reference/).
