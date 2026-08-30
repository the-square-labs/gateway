import { CORE_TOKEN_SCOPES } from "./scope-token-core";
import { INFRASTRUCTURE_TOKEN_SCOPES } from "./scope-token-infrastructure";
import { PLATFORM_TOKEN_SCOPES } from "./scope-token-platform";

export const TOKEN_SCOPES = [
  ...CORE_TOKEN_SCOPES,
  ...PLATFORM_TOKEN_SCOPES,
  ...INFRASTRUCTURE_TOKEN_SCOPES,
] as const;

const PROGRAMMATIC_DENIED_SCOPE_VALUES = new Set<string>([
  "ai:workspace:use",
  "feat:ai:use",
  "feat:ai:configure",
  "ai:skills:manage",
  "ai:sandbox:use",
  "ai:sandbox:tier:medium",
  "ai:sandbox:tier:high",
  "ai:sandbox:manage",
  "mcp:use",
  "inference:setup",
  "inference:providers:view",
  "inference:providers:manage",
  "inference:models:manage",
  "inference:limits:manage",
  "inference:usage:view",
  "admin:system",
  "admin:users",
  "admin:users:impersonate",
  "admin:groups",
  "settings:gateway:view",
  "settings:gateway:edit",
  "integrations:gitlab:manage",
  "integrations:gitlab:system",
  "integrations:github:manage",
  "integrations:github:system",
  "integrations:git:manage",
  "integrations:git:system",
  "integrations:ssh:manage",
  "integrations:cloudflare:manage",
  "proxy:raw:read",
  "proxy:raw:write",
  "proxy:raw:toggle",
  "proxy:raw:bypass",
  "proxy:advanced:bypass",
  "proxy:maintenance:bypass",
  "nodes:config:view",
  "nodes:config:edit",
]);

export const API_TOKEN_SCOPES = TOKEN_SCOPES.filter(
  (scope) => !PROGRAMMATIC_DENIED_SCOPE_VALUES.has(scope.value)
);

const MCP_EXTERNAL_INTEGRATION_SCOPE_PREFIXES = [
  "integrations:gitlab:",
  "integrations:github:",
  "integrations:git:",
  "integrations:ssh:",
] as const;

const MCP_EXTERNAL_INTEGRATION_READ_SCOPE_VALUES = new Set([
  "integrations:gitlab:view",
  "integrations:gitlab:projects:view",
  "integrations:gitlab:repo:read",
  "integrations:github:view",
  "integrations:git:view",
  "integrations:ssh:view",
]);

export const MCP_TOKEN_SCOPES = API_TOKEN_SCOPES.filter(
  (scope) =>
    MCP_EXTERNAL_INTEGRATION_READ_SCOPE_VALUES.has(scope.value) ||
    !MCP_EXTERNAL_INTEGRATION_SCOPE_PREFIXES.some((prefix) => scope.value.startsWith(prefix))
);

export const GROUP_ASSIGNABLE_SCOPES = TOKEN_SCOPES.filter(
  (scope) => scope.value !== "admin:system"
);
