---
{
  "id": "vks9ym4c",
  "file_name": "vks9ym4c_nginx_template_reconciliation",
  "tags": [
    "dns",
    "ipv6",
    "nginx",
    "proxy-hosts",
    "templates"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787839113583,
  "updated_at": 1787839113583
}
---
Gateway proxy hosts have an explicit `upstreamIpv6Enabled` setting in Settings -> Upstream. It defaults to false. For a managed manual hostname upstream with IPv6 disabled, rendered Nginx config must use runtime DNS through Gateway's configured IPv4 `DNS_RESOLVERS` with `ipv6=off`; IP-literal upstreams and Secure Link upstreams remain unchanged. Enabling the setting preserves native dual-stack resolution. Changes to Nginx template content or variables must trigger sequential regeneration of every enabled route assigned to that template, isolating per-route failures. Built-in template updates must also include enabled routes of the matching type that use the default template (`nginxTemplateId` null).
