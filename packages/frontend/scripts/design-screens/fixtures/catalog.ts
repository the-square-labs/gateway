/**
 * Names and ids shared across screens, so the dashboard, lists and details
 * describe one consistent (fictional) installation. Only reserved example
 * domains (RFC 2606) and documentation IP ranges (RFC 5737) are used.
 */
import { uuid } from "./time";

export const ORG = "Northwind";

export const routes = [
  { id: uuid(2001), slug: "app", domains: ["app.example.com"], health: "online", enabled: true },
  { id: uuid(2002), slug: "api", domains: ["api.example.com"], health: "online", enabled: true },
  { id: uuid(2003), slug: "auth", domains: ["auth.example.com"], health: "online", enabled: true },
  {
    id: uuid(2004),
    slug: "status",
    domains: ["status.example.com"],
    health: "online",
    enabled: true,
  },
  {
    id: uuid(2005),
    slug: "grafana",
    domains: ["grafana.example.com"],
    health: "degraded",
    enabled: true,
  },
  {
    id: uuid(2006),
    slug: "docs",
    domains: ["docs.example.org", "www.docs.example.org"],
    health: "online",
    enabled: true,
  },
  { id: uuid(2007), slug: "shop", domains: ["shop.example.net"], health: "online", enabled: true },
  {
    id: uuid(2008),
    slug: "legacy-admin",
    domains: ["legacy-admin.example.com"],
    health: "offline",
    enabled: true,
  },
  {
    id: uuid(2009),
    slug: "staging-app",
    domains: ["staging.app.example.com"],
    health: "unknown",
    enabled: false,
  },
] as const;

export const containers = [
  { id: "c0ffee01a1b2", name: "web", image: "registry.example.com/northwind/web:2.8.1" },
  { id: "c0ffee02a1b2", name: "api", image: "registry.example.com/northwind/api:2.8.1" },
  { id: "c0ffee03a1b2", name: "worker", image: "registry.example.com/northwind/worker:2.8.1" },
  { id: "c0ffee04a1b2", name: "grafana", image: "grafana/grafana:11.2.0" },
  { id: "c0ffee05a1b2", name: "redis-cache", image: "redis:7.4-alpine" },
] as const;

export const databases = [
  { id: uuid(3001), slug: "orders-db", name: "orders-db", type: "postgres" },
  { id: uuid(3002), slug: "sessions", name: "sessions", type: "redis" },
  { id: uuid(3003), slug: "analytics", name: "analytics", type: "postgres" },
] as const;

export const storages = [
  { id: uuid(4001), slug: "assets", name: "assets", provider: "s3" },
  { id: uuid(4002), slug: "backups", name: "backups", provider: "managed" },
] as const;

export const pageProjects = [
  { id: uuid(5001), slug: "marketing-site", name: "marketing-site" },
  { id: uuid(5002), slug: "docs-portal", name: "docs-portal" },
] as const;

export const people = [
  { id: "user-maya", name: "Maya Chen", email: "maya.chen@example.com" },
  { id: "user-omar", name: "Omar Haddad", email: "omar.haddad@example.com" },
  { id: "user-lena", name: "Lena Novak", email: "lena.novak@example.com" },
  { id: "user-sam", name: "Sam Patel", email: "sam.patel@example.com" },
] as const;
