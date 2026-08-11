import type { ForwardScheme, ProxyHost, RateLimitMode } from "@/types";

export interface ProxyHostDetailFormState {
  customHeaders: ProxyHost["customHeaders"];
  cacheEnabled: boolean;
  cacheMaxAge: number;
  rateLimitEnabled: boolean;
  rateLimitMode: RateLimitMode;
  rateLimitRPS: number;
  rateLimitBurst: number;
  rateLimitConnectionsPerIp: number;
  customRewrites: ProxyHost["customRewrites"];
  accessListId: string;
  healthCheckUrl: string;
  healthCheckExpectedStatus: number | null;
  healthCheckExpectedBody: string;
  healthCheckBodyMatchMode: "includes" | "exact" | "starts_with" | "ends_with";
  healthCheckSlowThreshold: number;
  nginxTemplateId: string;
  templateVariables: Record<string, string | number | boolean>;
  templateForwardScheme: ForwardScheme;
  templateForwardHost: string;
  templateForwardPort: number;
  templateRedirectUrl: string;
  templateRedirectStatusCode: number;
  advancedConfig: string;
  rawConfig: string;
}

export function deriveProxyHostDetailFormState(host: ProxyHost): ProxyHostDetailFormState {
  return {
    customHeaders: host.customHeaders || [],
    cacheEnabled: host.cacheEnabled,
    cacheMaxAge: host.cacheOptions?.maxAge || 3600,
    rateLimitEnabled: host.rateLimitEnabled,
    rateLimitMode: host.rateLimitMode ?? (host.rateLimitEnabled ? "custom" : "inherit"),
    rateLimitRPS: host.rateLimitOptions?.requestsPerSecond || 1000,
    rateLimitBurst: host.rateLimitOptions?.burst || 3000,
    rateLimitConnectionsPerIp: host.rateLimitOptions?.connectionsPerIp || 1000,
    customRewrites: host.customRewrites || [],
    accessListId: host.accessListId || "",
    healthCheckUrl: host.healthCheckUrl || "/",
    healthCheckExpectedStatus: host.healthCheckExpectedStatus ?? null,
    healthCheckExpectedBody: host.healthCheckExpectedBody || "",
    healthCheckBodyMatchMode: host.healthCheckBodyMatchMode || "includes",
    healthCheckSlowThreshold: host.healthCheckSlowThreshold ?? 3,
    nginxTemplateId: host.nginxTemplateId || "",
    templateVariables: host.templateVariables || {},
    templateForwardScheme: host.forwardScheme || "http",
    templateForwardHost: host.forwardHost || "",
    templateForwardPort: host.forwardPort || 80,
    templateRedirectUrl: host.redirectUrl || "",
    templateRedirectStatusCode: host.redirectStatusCode || 301,
    advancedConfig: host.advancedConfig || "",
    rawConfig: host.rawConfig || "",
  };
}
