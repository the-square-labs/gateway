import {
  Activity,
  Award,
  Bell,
  Box,
  Database,
  FileText,
  Globe,
  Globe2,
  LayoutDashboard,
  Lock,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import type { ElementType } from "react";
import { hasScopeBase, scopeMatches } from "@/lib/scope-utils";

export type AppNavigationGroupId = "main" | "reverse-proxy" | "pki" | "resources" | "management";

export type AppNavigationItemId =
  | "dashboard"
  | "profile"
  | "proxy-hosts"
  | "domains"
  | "ssl-certificates"
  | "authorities"
  | "certificates"
  | "docker"
  | "databases"
  | "logging"
  | "nodes"
  | "templates"
  | "access-lists"
  | "notifications"
  | "status-page"
  | "administration"
  | "settings";

export interface AppNavigationItem {
  id: AppNavigationItemId;
  name: string;
  href: string;
  icon: ElementType;
  shortcutKey?: string;
  keywords?: readonly string[];
}

export interface AppNavigationGroup {
  id: AppNavigationGroupId;
  label: string;
  items: readonly AppNavigationItem[];
}

export interface AppNavigationVisibility {
  scopes: readonly string[];
  pkiEnabled: boolean;
  siemEnabled: boolean;
  loggingEnabled: boolean;
  inferenceEnabled: boolean;
  hasLowInferenceUsage?: boolean;
  statusPageEnabled?: boolean;
  hasNginxNodes?: boolean;
  hasCloudflareIntegration?: boolean;
  hasDockerNodes?: boolean;
}

export const APP_NAVIGATION_GROUPS: readonly AppNavigationGroup[] = [
  {
    id: "main",
    label: "Main",
    items: [
      {
        id: "dashboard",
        name: "Dashboard",
        href: "/",
        icon: LayoutDashboard,
        shortcutKey: "1",
        keywords: ["overview", "home"],
      },
      {
        id: "profile",
        name: "Profile",
        href: "/profile",
        icon: UserRound,
        keywords: ["preferences", "authorizations", "tokens", "oauth"],
      },
    ],
  },
  {
    id: "reverse-proxy",
    label: "Ingress",
    items: [
      {
        id: "domains",
        name: "Domains",
        href: "/domains",
        icon: Globe2,
        shortcutKey: "2",
        keywords: ["dns", "cloudflare"],
      },
      {
        id: "proxy-hosts",
        name: "Routes",
        href: "/proxy-hosts",
        icon: Globe,
        shortcutKey: "3",
        keywords: ["nginx", "upstream", "reverse proxy", "route"],
      },
      {
        id: "ssl-certificates",
        name: "SSL Certificates",
        href: "/ssl-certificates",
        icon: Lock,
        shortcutKey: "4",
        keywords: ["tls", "acme", "letsencrypt"],
      },
    ],
  },
  {
    id: "pki",
    label: "PKI",
    items: [
      {
        id: "authorities",
        name: "Authorities",
        href: "/cas",
        icon: ShieldCheck,
        shortcutKey: "5",
        keywords: ["ca", "certificate authority", "root", "intermediate"],
      },
      {
        id: "certificates",
        name: "Certificates",
        href: "/certificates",
        icon: FileText,
        shortcutKey: "6",
        keywords: ["pki certificates"],
      },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    items: [
      {
        id: "docker",
        name: "Docker",
        href: "/docker",
        icon: Box,
        shortcutKey: "8",
        keywords: ["containers", "deployments", "images", "volumes", "networks", "tasks"],
      },
      {
        id: "databases",
        name: "Databases",
        href: "/databases",
        icon: Database,
        keywords: ["postgres", "postgresql", "clickhouse", "redis"],
      },
      {
        id: "logging",
        name: "Logging",
        href: "/logging",
        icon: ScrollText,
        keywords: ["logs", "schemas", "environments", "ingest"],
      },
      {
        id: "nodes",
        name: "Nodes",
        href: "/nodes",
        icon: Server,
        shortcutKey: "9",
        keywords: ["daemons", "servers", "hosts"],
      },
    ],
  },
  {
    id: "management",
    label: "Management",
    items: [
      {
        id: "templates",
        name: "Templates",
        href: "/templates",
        icon: Award,
        shortcutKey: "7",
        keywords: ["nginx templates", "pki templates", "certificate templates"],
      },
      {
        id: "access-lists",
        name: "Access Lists",
        href: "/access-lists",
        icon: ShieldAlert,
        shortcutKey: "0",
        keywords: ["acl", "ip rules", "basic auth"],
      },
      {
        id: "notifications",
        name: "Notifications",
        href: "/notifications",
        icon: Bell,
        keywords: ["alerts", "webhooks", "delivery log", "siem", "audit export"],
      },
      {
        id: "status-page",
        name: "Status Page",
        href: "/status-page",
        icon: Activity,
        keywords: ["services", "incidents", "public status"],
      },
      {
        id: "administration",
        name: "Administration",
        href: "/administration",
        icon: Users,
        keywords: ["users", "groups", "audit log"],
      },
      {
        id: "settings",
        name: "Settings",
        href: "/settings",
        icon: Settings,
        keywords: [
          "gateway",
          "features",
          "integrations",
          "gitlab",
          "cloudflare",
          "ai assistant",
          "inference",
          "license",
          "updates",
          "docker registries",
          "housekeeping",
        ],
      },
    ],
  },
] as const;

const NOTIFICATION_CORE_SCOPES = [
  "notifications:alerts:view",
  "notifications:alerts:create",
  "notifications:alerts:edit",
  "notifications:alerts:delete",
  "notifications:webhooks:view",
  "notifications:webhooks:create",
  "notifications:webhooks:edit",
  "notifications:webhooks:delete",
  "notifications:deliveries:view",
  "notifications:view",
  "notifications:manage",
] as const;

const SIEM_NOTIFICATION_SCOPES = ["audit:siem:view", "audit:siem:manage"] as const;

const SETTINGS_SCOPES = [
  "settings:gateway:view",
  "settings:gateway:edit",
  "docker:registries:view",
  "admin:update",
  "license:view",
  "license:manage",
  "status-page:view",
  "housekeeping:view",
  "housekeeping:run",
  "housekeeping:configure",
  "integrations:gitlab:view",
  "integrations:gitlab:manage",
  "integrations:cloudflare:view",
  "integrations:cloudflare:manage",
  "integrations:cloudflare:dns:view",
  "integrations:cloudflare:dns:edit",
  "integrations:cloudflare:dns:delete",
  "feat:ai:configure",
] as const;

function hasAnyScope(scopes: readonly string[], required: readonly string[]): boolean {
  return required.some((scope) => scopeMatches(scopes, scope));
}

export function hasDashboardContent(context: AppNavigationVisibility): boolean {
  const { scopes } = context;
  return (
    hasScopeBase(scopes, "proxy:view") ||
    hasScopeBase(scopes, "ssl:cert:view") ||
    hasScopeBase(scopes, "nodes:details") ||
    scopeMatches(scopes, "admin:audit") ||
    (context.pkiEnabled &&
      (hasScopeBase(scopes, "pki:cert:view") ||
        hasAnyScope(scopes, ["pki:ca:view:root", "pki:ca:view:intermediate"]))) ||
    (context.inferenceEnabled &&
      context.hasLowInferenceUsage === true &&
      scopeMatches(scopes, "feat:ai:use"))
  );
}

export function canAccessNavigationItem(
  item: AppNavigationItem,
  context: AppNavigationVisibility
): boolean {
  const { scopes } = context;
  switch (item.id) {
    case "dashboard":
      return hasDashboardContent(context);
    case "profile":
      return true;
    case "proxy-hosts":
      return hasScopeBase(scopes, "proxy:view") || scopeMatches(scopes, "proxy:folders:manage");
    case "domains":
      return hasScopeBase(scopes, "domains:view");
    case "ssl-certificates":
      return hasScopeBase(scopes, "ssl:cert:view");
    case "authorities":
      return (
        context.pkiEnabled && hasAnyScope(scopes, ["pki:ca:view:root", "pki:ca:view:intermediate"])
      );
    case "certificates":
      return context.pkiEnabled && hasScopeBase(scopes, "pki:cert:view");
    case "docker": {
      const canAccess =
        hasScopeBase(scopes, "docker:containers:view") ||
        hasScopeBase(scopes, "docker:images:view") ||
        hasScopeBase(scopes, "docker:volumes:view") ||
        hasScopeBase(scopes, "docker:networks:view") ||
        scopeMatches(scopes, "docker:tasks") ||
        scopeMatches(scopes, "docker:containers:folders:manage");
      return (
        canAccess &&
        (context.hasDockerNodes !== false ||
          scopeMatches(scopes, "docker:containers:folders:manage"))
      );
    }
    case "databases":
      return (
        hasScopeBase(scopes, "databases:view") || scopeMatches(scopes, "databases:folders:manage")
      );
    case "logging":
      return (
        context.loggingEnabled &&
        (hasScopeBase(scopes, "logs:environments:view") ||
          hasScopeBase(scopes, "logs:schemas:view") ||
          hasAnyScope(scopes, ["logs:schemas:create", "logs:read", "logs:manage"]))
      );
    case "nodes":
      return hasScopeBase(scopes, "nodes:details") || scopeMatches(scopes, "nodes:folders:manage");
    case "templates":
      return (
        (context.pkiEnabled && hasScopeBase(scopes, "pki:templates:view")) ||
        hasScopeBase(scopes, "proxy:templates:view")
      );
    case "access-lists":
      return hasScopeBase(scopes, "acl:view");
    case "notifications":
      return (
        hasAnyScope(scopes, NOTIFICATION_CORE_SCOPES) ||
        (context.siemEnabled && hasAnyScope(scopes, SIEM_NOTIFICATION_SCOPES))
      );
    case "status-page":
      return context.statusPageEnabled === true && scopeMatches(scopes, "status-page:view");
    case "administration":
      return hasAnyScope(scopes, ["admin:audit", "admin:users", "admin:groups"]);
    case "settings":
      return (
        hasAnyScope(scopes, SETTINGS_SCOPES) ||
        (context.inferenceEnabled &&
          hasAnyScope(scopes, [
            "inference:providers:view",
            "inference:providers:manage",
            "inference:models:manage",
            "inference:limits:manage",
            "inference:usage:view",
          ]))
      );
  }
}

export function visibleNavigationGroups(context: AppNavigationVisibility): AppNavigationGroup[] {
  return APP_NAVIGATION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessNavigationItem(item, context)),
  })).filter((group) => group.items.length > 0);
}

export function keyboardNavigationRoutes(context: AppNavigationVisibility): Record<string, string> {
  return Object.fromEntries(
    APP_NAVIGATION_GROUPS.flatMap((group) => group.items)
      .filter(
        (item): item is AppNavigationItem & { shortcutKey: string } =>
          !!item.shortcutKey && canAccessNavigationItem(item, context)
      )
      .map((item) => [item.shortcutKey, item.href])
  );
}
