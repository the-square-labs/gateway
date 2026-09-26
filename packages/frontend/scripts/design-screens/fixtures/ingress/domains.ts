/** The Cloudflare DNS preview the Add Domain dialog shows for a new hostname. */
import { http } from "msw";
import type { CloudflareDomainPreview } from "@/types";
import { wrapped } from "../../handlers";
import { CLOUDFLARE_CONNECTOR_ID, domainNginxNodes } from "../edge/domains";

export function domainPreviewHandlers() {
  return [
    http.post("*/api/domains/preview", async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as {
        domain?: string;
        nginxNodeId?: string;
        ttl?: number;
        proxied?: boolean;
      };
      const node =
        domainNginxNodes.eligibleNodes.find((item) => item.id === body.nginxNodeId) ??
        domainNginxNodes.eligibleNodes[0];
      const domain = body.domain?.trim() || "billing.example.com";
      const preview: CloudflareDomainPreview = {
        dnsProvider: "cloudflare",
        domain,
        zoneName: "example.com",
        connectorId: CLOUDFLARE_CONNECTOR_ID,
        nginxNode: node,
        targetIps: [node.effectiveAddress],
        ttl: body.ttl ?? 300,
        proxied: body.proxied ?? false,
        desiredRecords: [
          {
            type: "A",
            name: domain,
            content: node.effectiveAddress,
            ttl: body.ttl ?? 300,
            proxied: false,
          },
        ],
        currentRecords: [],
        status: "ready",
        canOverwrite: false,
      };
      return wrapped(preview);
    }),
  ];
}
