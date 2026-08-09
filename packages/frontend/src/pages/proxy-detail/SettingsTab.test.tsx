import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { ProxyHost, SSLCertificate } from "@/types";
import { SettingsTab, type SettingsTabProps } from "./SettingsTab";

const host = {
  type: "404",
  websocketSupport: false,
  sslEnabled: false,
  sslForced: false,
  http2Support: false,
  sslCertificateId: null,
  healthCheckEnabled: false,
} as ProxyHost;

const certificate = {
  id: "cert-1",
  name: "Example certificate",
  type: "acme",
} as SSLCertificate;

function makeProps(overrides: Partial<SettingsTabProps> = {}): SettingsTabProps {
  return {
    host,
    onHostUpdated: vi.fn(),
    onToggle: vi.fn(),
    customHeaders: [],
    setCustomHeaders: vi.fn(),
    cacheEnabled: false,
    setCacheEnabled: vi.fn(),
    cacheMaxAge: 3600,
    setCacheMaxAge: vi.fn(),
    rateLimitEnabled: false,
    setRateLimitEnabled: vi.fn(),
    rateLimitRPS: 100,
    setRateLimitRPS: vi.fn(),
    rateLimitBurst: 200,
    setRateLimitBurst: vi.fn(),
    customRewrites: [],
    setCustomRewrites: vi.fn(),
    onSaveCustom: vi.fn(),
    isSavingCustom: false,
    accessListId: "",
    accessLists: [],
    onAccessListChange: vi.fn(),
    sslCerts: [certificate],
    onSslCertificateChange: vi.fn(),
    nginxTemplates: [],
    nginxTemplateId: "",
    onNginxTemplateChange: vi.fn(),
    selectedTemplate: null,
    templateVariables: {},
    onTemplateVariableChange: vi.fn(),
    templateForwardScheme: "http",
    setTemplateForwardScheme: vi.fn(),
    templateForwardHost: "",
    setTemplateForwardHost: vi.fn(),
    templateForwardPort: 80,
    setTemplateForwardPort: vi.fn(),
    templateRedirectUrl: "",
    setTemplateRedirectUrl: vi.fn(),
    templateRedirectStatusCode: 301,
    setTemplateRedirectStatusCode: vi.fn(),
    onSaveTemplateSettings: vi.fn(),
    isSavingTemplate: false,
    hasTemplateSettingsChanged: false,
    canManage: true,
    hasHeadersChanged: false,
    hasRewritesChanged: false,
    healthCheckUrl: "/",
    setHealthCheckUrl: vi.fn(),
    healthCheckExpectedStatus: null,
    setHealthCheckExpectedStatus: vi.fn(),
    healthCheckExpectedBody: "",
    setHealthCheckExpectedBody: vi.fn(),
    healthCheckBodyMatchMode: "includes",
    setHealthCheckBodyMatchMode: vi.fn(),
    healthCheckSlowThreshold: 3,
    setHealthCheckSlowThreshold: vi.fn(),
    canResyncTls: false,
    isTlsResyncing: false,
    onTlsResync: vi.fn(),
    ...overrides,
  };
}

describe("proxy detail SettingsTab", () => {
  it("keeps the access-list combobox outside the panel clipping boundary", () => {
    render(<SettingsTab {...makeProps()} />);

    expect(screen.getByText("Access List").closest("div.border")).toHaveClass("overflow-visible");
  });

  it("lays out WebSocket and Access List panels by their available container width", () => {
    render(<SettingsTab {...makeProps({ host: { ...host, type: "proxy" } })} />);

    expect(screen.getByText("WebSocket Support").closest("div.grid")).toHaveStyle(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 32rem), 1fr))"
    );
  });

  it("renders TLS distribution as a neutral settings panel with only the status badge colored", () => {
    render(
      <SettingsTab
        {...makeProps({
          host: {
            ...host,
            sslEnabled: true,
            tlsDistribution: {
              status: "ready",
              replicaCount: 2,
              readyReplicaCount: 2,
              lastVerifiedAt: "2026-08-09T12:00:00.000Z",
              error: null,
            },
          } as ProxyHost,
        })}
      />
    );

    const panel = screen.getByText("TLS distribution").closest("div.border");
    expect(panel).toHaveClass("border-border", "bg-card");
    expect(panel).not.toHaveClass("bg-success/10", "border-success/40");
    expect(panel?.querySelector(".border-t")).toBeNull();
    expect(screen.getByText("ready").parentElement).toHaveClass("bg-emerald-500/15");
  });

  it("allows selecting an SSL certificate before SSL is enabled", () => {
    render(<SettingsTab {...makeProps()} />);

    expect(screen.getByRole("combobox", { name: "SSL Certificate" })).toBeEnabled();
  });

  it("keeps SSL certificate selection disabled without edit permission", () => {
    render(<SettingsTab {...makeProps({ canManage: false })} />);

    expect(screen.getByRole("combobox", { name: "SSL Certificate" })).toBeDisabled();
  });
});
