import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("license requirement badge callsites", () => {
  it.each([
    ["pages/CAs.tsx", ["internal-pki"]],
    ["pages/Certificates.tsx", ["internal-pki"]],
    ["pages/Notifications.tsx", ["siem-export"]],
    ["pages/TemplatesPage.tsx", ["internal-pki"]],
    ["pages/settings/AuthProvisioningSection.tsx", ["internal-pki", "siem-export"]],
    ["pages/pages/PageGlobalSettings.tsx", ["pages", "pages"]],
    ["pages/settings/StatusPageSection.tsx", ["status-pages"]],
    ["pages/settings/InternalRegistrySection.tsx", ["git-push-to-deploy"]],
  ] as const)("%s uses the shared entitlement-aware badge", (path, features) => {
    const source = readFileSync(resolve(process.cwd(), "src", path), "utf8");
    expect(source).toContain(
      'import { LicensePlanBadge } from "@/components/license/LicensePlanBadge"'
    );
    const badges = [...source.matchAll(/<LicensePlanBadge\b[^>]*\/>/g)].map(([badge]) => badge);
    expect(badges).toHaveLength(features.length);
    for (const [index, feature] of features.entries()) {
      expect(badges[index]).toContain(`feature="${feature}"`);
      expect(badges[index]).not.toMatch(/\bplan=/);
    }
  });
});
