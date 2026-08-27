---
{
  "id": "vks9ym4c",
  "file_name": "vks9ym4c_nginx_template_reconciliation",
  "tags": [
    "dns",
    "ipv6",
    "nginx",
    "production-validation",
    "proxy",
    "templates"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1787839113583,
  "updated_at": 1787839913574
}
---
# Gateway Nginx and DNS Reconciliation Context

- Gateway proxy hosts expose `Settings → Upstream → upstreamIpv6Enabled`, defaulting to `false`.
- For managed manual hostname upstreams with IPv6 disabled:
  - Render runtime DNS resolution through Gateway’s configured IPv4 `DNS_RESOLVERS`.
  - Include `ipv6=off`.
  - Use compact deterministic Nginx variable names (currently a `gw_up_` prefix plus 16 hex characters) so production defaults such as `variables_hash_bucket_size 64` remain valid.
  - Validate generated configs against the production Nginx version with realistic generated identifier lengths; a minimal syntax test with a shorter placeholder can miss hash-bucket failures.
  - Leave IP-literal upstreams and Secure Link upstreams unchanged.
- Enabling `upstreamIpv6Enabled` preserves native dual-stack DNS resolution.

## Template Regeneration

- Changes to Nginx template content or variables must sequentially regenerate every enabled route assigned to that template.
- Isolate failures per route so one failure does not prevent processing others.
- Built-in template updates must also include enabled routes of the matching type using the default template (`nginxTemplateId IS NULL`).
- Changing a built-in template does not rewrite already-applied configurations; affected managed proxy hosts/nodes must be reapplied.
- Raw/custom templates remain explicit operator-managed escape hatches.

## Access-Control Injection

- Keep `allow`, `deny`, and `auth_basic` directives in generated `location /`; do not hoist them to server scope, preserving the ACME exception boundary.
- Inject the same directives into every direct advanced server-level location during built-in template rendering and pure config generation.
- Reject these directives in normal advanced configuration:
  - `allow`
  - `deny`
  - `auth_basic`
  - `auth_basic_user_file`
  - `satisfy`

## Domain-to-Nginx Node Affinity

- A registered Domain targets one eligible Nginx node, selected deterministically from daemon-reported publicly routable IPs.
- Ineligible addresses include private, unreported, custom, and IANA special-purpose addresses; globally reachable IANA exceptions within broader protocol ranges remain eligible.
- Canonicalize domain names to lowercase.
- Exact and wildcard Proxy Host usage for a Domain must share the same Nginx node; lookups cover both base and wildcard registrations and compare legacy JSONB values case-insensitively.
- Existing domains:
  - Backfill by unambiguous Proxy Host affinity.
  - Use the first eligible node only when unused.
  - Leave ambiguous or ineligible usage unresolved.
- Legacy-provider domains receive node affinity without creating a managed DNS target and continue normal resolved-DNS evaluation.
- Health/startup reconciliation may backfill or repair drift to the stored target but must not silently retarget an established Domain after node-address changes.
- User-confirmed node target changes require `domains:edit` and atomically store the node address with `pendingDnsTargetIp`.
- Success and failure persistence must use target-aware CAS so stale runs cannot clear, overwrite, or invalidate newer intent.
- Transient provider failures remain retryable.
- Node-only errors report affected counts without exposing Domain names.
- Retain the restrictive Domain-to-node foreign key and pre-delete domain-assignment check.

## Cloudflare Reconciliation

- Mutate only tracked address records.
- Before mutation, refuse every untracked A/AAAA/CNAME record.
- Use a stable Gateway ownership comment to recover a replacement created before a database failure.
- Use `PATCH` when editing records so omitted Cloudflare metadata is preserved.
