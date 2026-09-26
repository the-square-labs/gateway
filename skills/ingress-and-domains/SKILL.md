---
name: ingress-and-domains
description: Expose and troubleshoot services through Gateway ingress, including Domains and DNS, Routes (proxy hosts) to Docker, Pages, or manual upstreams, SSL certificates from ACME, upload, or internal PKI, Access Lists, Additional Routes, Secure Links, nginx templates, and maintenance mode. Use when asked to put a service on a hostname, add HTTPS, restrict access by IP or basic auth, put a Route into maintenance, or find out why a Route, Domain, or certificate is not working. Use after using-gateway has confirmed the Gateway MCP connection.
---

# Ingress and Domains

The Console and tools call these resources **Routes**; REST paths and the resource type keep the legacy name `proxy-hosts` / `proxy_host`. Each Route is one nginx server block on exactly one assigned ingress (`nginx`) Node.

Start with `using-gateway` for connection, discovery, and safety rules. Use this skill after the target workload or Pages Tag exists, or when the request is about ingress itself. Read `read_gateway_documentation({ topic: "proxy" })` (also `domains`, `ssl`, `acme`, `access-lists`) before an unfamiliar workflow.

## Publish a hostname

1. **Domain.** Find the registered Domain with `list_domains` or `find_resource({ types: ["domain"] })`, or create it with `create_domain({ domain, nginxNodeId })` on the Ingress Node that will serve the Route. A Domain and every Route using it stay on the same Node. Inspect existing DNS before any managed DNS write.
2. **DNS.** For external DNS, return the exact record change and wait for the user or provider. With a Cloudflare connector, Gateway creates or reconciles A/AAAA records; when it reports conflicting records, overwrite or adopt only after explicit approval. Re-check with `manage_domain({ operation: "check_dns", domainId })`.
3. **TLS.** Reuse a compatible ready SSL certificate, or issue one: HTTP-01 needs the Domain resolving to the assigned online Ingress Node with public port 80 reachable; DNS-01 through a matching Cloudflare connector is automatic; manual DNS-01 returns a TXT record the user must create before verification. The certificate is usable only when Gateway reports it ready. Details: [TLS and Access Lists](references/tls-and-access-lists.md).
4. **Route.** `create_route` or `update_route` with a stable target and the SSL certificate ID (never a PKI certificate ID). Target shapes, Additional Routes, Secure Links, and templates: [Routes and upstreams](references/routes-and-upstreams.md).
5. **Verify** in layers (below) before returning a URL.

Enable WebSockets, redirects, Access Lists, headers, caching, rate limits, maintenance, health checks, or advanced nginx configuration only when the application needs them. Never convert or replace an unrelated live Route because its hostname looks similar.

## Stable Route targets

- Standalone Container: Docker Node, stable Container name, application port.
- Compose service: Docker Node, Compose Project, service name, application port; re-resolves after Compose recreates the Container.
- Blue/green Deployment: Docker Node, Deployment ID, application port.
- Pages: Page Project and a ready mutable Tag, never an immutable Deployment (`publishing-html-pages`).
- Manual upstream: explicit host, port, and scheme.

## Access Lists and maintenance

- An Access List combines ordered IP allow/deny rules (first match wins) with optional HTTP basic auth. It attaches to Routes through `accessListId` and to Pages previews through the Page Project; editing a shared list updates everything that uses it.
- Never invent, request, or relay basic-auth passwords in chat. Prefer IP rules for lists you create; for basic auth, let the user add users in the Gateway Console, then attach the list by ID.
- `set_route_maintenance({ routeId, enabled })` serves HTTP 503 while keeping the vhosts listening and pausing managed health checks. Use it instead of disabling the Route or editing its config, so the change stays audited and reaches notification rules and status pages. It works on enabled, non-raw Routes only.

## Verify in layers

1. The target resource is ready and healthy.
2. The Route is enabled and applied on the expected Ingress Node.
3. The Domain resolves to that Node.
4. TLS is valid for the hostname, with the expected chain and `notAfter`.
5. An external HTTPS request returns the expected status and, when practical, recognizable content or a health response; with `sslForced`, plain HTTP redirects to HTTPS.

Return a verified URL only after the relevant layers pass. Certificate issuance and delivery are separate steps: Gateway stores the certificate, pushes a replica to the Route's Ingress Node, and applies config atomically (`nginx -t`, then reload). If external verification is unavailable, name the layers that passed and say public reachability was not tested.

## Pitfalls

- Moving a Domain to another Ingress Node is an explicit migration: the Domain and all its Routes move together, and external DNS must be repointed first.
- Domains used by a Route, and system Domains, cannot be deleted.
- Raw config (`proxy:raw:write`), `proxy:unrestricted`, and `proxy:templates:manage` are OAuth manual-approval scopes; expect them to be missing unless explicitly granted, and treat raw mode as high risk.
- ACME production limits are 5 duplicate certificates per week and 50 certificates per registered domain per week. Use staging while testing.
- Ingress Secure Links (nginx to a destination) differ from database and storage workload links; use `databases` or `storage` for those.

Further reading: [Ingress overview](https://docs.goodgateway.dev/en/ingress/overview/), [Ingress troubleshooting](https://docs.goodgateway.dev/en/ingress/troubleshooting/).
