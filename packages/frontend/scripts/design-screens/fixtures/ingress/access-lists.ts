/**
 * Access lists of the installation: the three the routes reference plus two
 * more, so the list page reads like a real one. Seeds 22200-22299.
 */
import { http } from "msw";
import type { AccessList } from "@/types";
import { ok } from "../../handlers";
import { accessLists as routeAccessLists } from "../routes/data";
import { ago, uuid } from "../time";

export const accessLists: AccessList[] = [
  ...routeAccessLists,
  {
    id: uuid(22201),
    name: "Support portal",
    description: "Support desk network plus per-agent logins",
    ipRules: [
      { type: "allow", value: "10.0.40.0/24" },
      { type: "allow", value: "192.0.2.200" },
      { type: "deny", value: "all" },
    ],
    basicAuthEnabled: true,
    basicAuthUsers: [
      { username: "lena.novak" },
      { username: "sam.patel" },
      { username: "omar.haddad" },
    ],
    createdAt: ago(64, "d"),
    updatedAt: ago(3, "d"),
    usageCount: 1,
  },
  {
    id: uuid(22202),
    name: "Block scanners",
    description: "Known abusive ranges seen in the access logs",
    ipRules: [
      { type: "deny", value: "198.51.100.200/29" },
      { type: "deny", value: "203.0.113.250" },
      { type: "allow", value: "all" },
    ],
    basicAuthEnabled: false,
    basicAuthUsers: [],
    createdAt: ago(21, "d"),
    updatedAt: ago(21, "d"),
    usageCount: 4,
  },
];

export const supportPortalAccessList = accessLists.find((list) => list.name === "Support portal")!;

export function accessListHandlers() {
  return [
    http.get("*/api/access-lists", ({ request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
      return ok({
        data: accessLists,
        pagination: { page: 1, limit, total: accessLists.length, totalPages: 1 },
      });
    }),
  ];
}
