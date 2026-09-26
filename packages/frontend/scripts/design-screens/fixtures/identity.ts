import type { User } from "@/types";
import { TOKEN_SCOPES } from "@/types/scope-token-catalog";

/** A fictional operator with every scope, so every navigation entry and action shows. */
export const adminUser: User = {
  id: "user-maya",
  oidcSubject: "oidc-maya",
  authMethod: "oidc",
  email: "maya.chen@example.com",
  name: "Maya Chen",
  avatarUrl: null,
  groupId: "group-admins",
  groupIds: ["group-admins"],
  groupNames: ["system-admin"],
  groupName: "system-admin",
  scopes: Array.from(new Set([...TOKEN_SCOPES.map((scope) => scope.value), "admin:system"])),
  isBlocked: false,
  aiApprovalMode: "normal",
};
