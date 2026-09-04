import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { NginxTemplate, ProxyHost, SSLCertificate } from "@/types";
import { SettingsTab, type SettingsTabProps } from "./SettingsTab";

const host = {
  domainNames: ["example.com"],
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
  domainNames: ["example.com"],
} as SSLCertificate;

function makeProps(overrides: Partial<SettingsTabProps> = {}): SettingsTabProps {
  return {
    host,
    onHostUpdated: vi.fn(),
    onToggle: vi.fn(),
    customHeaders: [],
    setCustomHeaders: vi.fn(),
    customRewrites: [],
    setCustomRewrites: vi.fn(),
    onSaveHeaders: vi.fn(),
    onSaveRewrites: vi.fn(),
    isSavingCustom: false,
    accessListId: "",
    accessLists: [],
    onAccessListChange: vi.fn(),
    sslCerts: [certificate],
    sslEnabled: false,
    setSslEnabled: vi.fn(),
    sslForced: false,
    setSslForced: vi.fn(),
    http2Support: false,
    setHttp2Support: vi.fn(),
    sslCertificateId: "",
    setSslCertificateId: vi.fn(),
    onSaveSsl: vi.fn(),
    isSavingSsl: false,
    hasSslSettingsChanged: false,
    nginxTemplates: [],
    nginxTemplateId: "",
    onNginxTemplateChange: vi.fn(),
    selectedTemplate: null,
    templateVariables: {},
    onTemplateVariableChange: vi.fn(),
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
    healthCheckEnabled: false,
    setHealthCheckEnabled: vi.fn(),
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
    onSaveHealthCheck: vi.fn(),
    isSavingHealthCheck: false,
    hasHealthCheckSettingsChanged: false,
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
    expect(screen.getByText("Access List").closest("h3")?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "About Policy" })).toBeInTheDocument();
    expect(screen.getByText("Config Template").closest("h3")?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "About Template" })).toBeInTheDocument();
    expect(screen.getByText("SSL").closest("h3")?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "About SSL Certificate" })).toBeInTheDocument();
  });

  it("lays out WebSocket and Access List panels by their available container width", () => {
    render(<SettingsTab {...makeProps({ host: { ...host, type: "proxy" } })} />);

    expect(screen.getByText("WebSocket Support").closest("div.grid")).toHaveStyle(
      "grid-template-columns: repeat(auto-fit, minmax(min(100%, 32rem), 1fr))"
    );
    expect(screen.getByText("Access List").closest("div.border")).toHaveTextContent("Policy");
    expect(screen.getByRole("combobox", { name: "Access List policy" })).toBeEnabled();
  });

  it("hides upstream-only controls for static Pages Routes", () => {
    render(
      <SettingsTab
        {...makeProps({ host: { ...host, type: "proxy", upstreamKind: "pages" } as ProxyHost })}
      />
    );

    expect(screen.queryByText("WebSocket Support")).not.toBeInTheDocument();
    expect(screen.getByText("Health Check")).toBeInTheDocument();
    expect(screen.getByText("Health Check").closest("h3")?.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "About Expected Status" })).toBeInTheDocument();
  });

  it("renders cacheEnabled as an Enabled or Disabled dropdown", () => {
    const defaultTemplate = {
      id: "template-default",
      name: "Default Proxy",
      type: "proxy",
      variables: [
        {
          name: "cacheEnabled",
          description: "Cache upstream responses",
          type: "boolean",
          default: false,
        },
      ],
    } as NginxTemplate;

    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "proxy" },
          selectedTemplate: defaultTemplate,
          templateVariables: { cacheEnabled: false },
        })}
      />
    );

    expect(screen.getByRole("combobox", { name: "Cache enabled" })).toHaveTextContent("Disabled");
  });

  it("hides TLS distribution when every replica is ready", () => {
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

    expect(screen.queryByText("TLS distribution")).not.toBeInTheDocument();
  });

  it("renders TLS distribution problems as a neutral settings panel", () => {
    render(
      <SettingsTab
        {...makeProps({
          canResyncTls: true,
          host: {
            ...host,
            sslEnabled: true,
            tlsDistribution: {
              status: "failed",
              replicaCount: 2,
              readyReplicaCount: 1,
              lastVerifiedAt: "2026-08-09T12:00:00.000Z",
              error: "Replica unavailable",
            },
          } as ProxyHost,
        })}
      />
    );

    const panel = screen.getByText("TLS distribution").closest("div.border");
    expect(panel).toHaveClass("border-border", "bg-card");
    expect(panel).not.toHaveClass("bg-success/10", "border-success/40");
    expect(panel?.querySelector(".border-t")).toBeNull();
    expect(screen.getByText("failed").parentElement).toHaveClass("bg-red-500/15");
    expect(screen.getByRole("button", { name: /retry tls sync/i })).toHaveClass("h-9", "px-4");
    expect(screen.getByRole("button", { name: /retry tls sync/i })).not.toHaveClass(
      "h-8",
      "text-xs"
    );
  });

  it("allows selecting an SSL certificate before SSL is enabled", () => {
    render(<SettingsTab {...makeProps()} />);

    expect(screen.getByRole("combobox", { name: "SSL Certificate" })).toBeEnabled();
  });

  it("uses SSL certificate text as search only and commits selected certificate IDs", async () => {
    const user = userEvent.setup();
    const setSslCertificateId = vi.fn();
    render(<SettingsTab {...makeProps({ setSslCertificateId })} />);

    const certificateCombobox = screen.getByRole("combobox", { name: "SSL Certificate" });
    expect(certificateCombobox).toHaveValue("None");

    await user.click(certificateCombobox);
    await user.type(certificateCombobox, "missing");
    expect(screen.getByText("No matching certificates.")).toBeInTheDocument();
    await user.tab();

    expect(setSslCertificateId).not.toHaveBeenCalled();
    expect(certificateCombobox).toHaveValue("None");

    await user.click(certificateCombobox);
    await user.type(certificateCombobox, "Example");
    await user.click(screen.getByRole("button", { name: "Example certificate (acme)" }));

    expect(setSslCertificateId).toHaveBeenCalledWith("cert-1");
  });

  it("keeps SSL certificate selection disabled without edit permission", () => {
    render(<SettingsTab {...makeProps({ canManage: false })} />);

    expect(screen.getByRole("combobox", { name: "SSL Certificate" })).toBeDisabled();
  });

  it("keeps SSL changes local until the section Save action", async () => {
    const user = userEvent.setup();
    const setSslEnabled = vi.fn();
    const onSaveSsl = vi.fn();
    render(<SettingsTab {...makeProps({ setSslEnabled, onSaveSsl })} />);

    const sslPanel = screen.getByText("SSL").closest("div.border");
    expect(sslPanel).not.toBeNull();
    await user.click(
      (sslPanel as HTMLElement).querySelector('button[aria-pressed="false"]') as HTMLElement
    );

    expect(setSslEnabled).toHaveBeenCalledWith(true);
    expect(onSaveSsl).not.toHaveBeenCalled();
  });

  it("keeps health-check changes local until the section Save action", async () => {
    const user = userEvent.setup();
    const setHealthCheckEnabled = vi.fn();
    const onSaveHealthCheck = vi.fn();
    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "redirect" },
          setHealthCheckEnabled,
          onSaveHealthCheck,
        })}
      />
    );

    const healthPanel = screen.getByText("Health Check").closest("div.border");
    expect(healthPanel).not.toBeNull();
    await user.click(
      (healthPanel as HTMLElement).querySelector('button[aria-pressed="false"]') as HTMLElement
    );

    expect(setHealthCheckEnabled).toHaveBeenCalledWith(true);
    expect(onSaveHealthCheck).not.toHaveBeenCalled();
  });

  it("shows an explicit pending state while a settings section is saving", () => {
    render(
      <SettingsTab
        {...makeProps({
          isSavingTemplate: true,
          hasTemplateSettingsChanged: true,
        })}
      />
    );

    const saveButton = screen.getByRole("button", { name: "Saving..." });
    expect(saveButton).toBeDisabled();
    expect(saveButton.querySelector(".animate-spin")).not.toBeNull();
  });

  it("renders redirect settings as standard rows with supported status codes", async () => {
    const user = userEvent.setup();
    const setTemplateRedirectStatusCode = vi.fn();
    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "redirect" },
          templateRedirectUrl: "https://example.com",
          templateRedirectStatusCode: 301,
          setTemplateRedirectStatusCode,
        })}
      />
    );

    expect(screen.getByDisplayValue("https://example.com")).toBeInTheDocument();
    const statusCode = screen.getByRole("combobox", { name: "Redirect status code" });
    await user.click(statusCode);
    await user.click(screen.getByRole("option", { name: "308 — Permanent, preserve method" }));

    expect(setTemplateRedirectStatusCode).toHaveBeenCalledWith(308);
  });

  it("keeps health-check body controls accessible without nested field captions", () => {
    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "redirect" },
          healthCheckEnabled: true,
        })}
      />
    );

    expect(screen.getByRole("combobox", { name: "Expected body match mode" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Expected body value" })).toBeEnabled();
  });

  it("marks every saveable settings panel with the shared dirty border", () => {
    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "redirect" },
          hasTemplateSettingsChanged: true,
          hasSslSettingsChanged: true,
          hasHealthCheckSettingsChanged: true,
          hasHeadersChanged: true,
          hasRewritesChanged: true,
        })}
      />
    );

    for (const title of [
      "Config Template",
      "SSL",
      "Health Check",
      "Custom Headers",
      "URL Rewrites",
    ]) {
      expect(screen.getByText(title).closest("div.border")).toHaveStyle({
        borderColor: "var(--color-warning)",
      });
    }
  });

  it("shows inherited request and concurrent connection protection", () => {
    const defaultTemplate = {
      id: "template-default",
      name: "Default Proxy",
      type: "proxy",
      variables: [
        { name: "rateLimitMode", type: "string", default: "inherit" },
        { name: "rateLimitRPS", type: "number", default: 1000 },
        { name: "rateLimitBurst", type: "number", default: 3000 },
        { name: "connectionsPerIp", type: "number", default: 1000 },
      ],
    } as NginxTemplate;

    render(
      <SettingsTab
        {...makeProps({
          host: { ...host, type: "proxy" },
          selectedTemplate: defaultTemplate,
          templateVariables: {
            rateLimitMode: "inherit",
            rateLimitRPS: 1000,
            rateLimitBurst: 3000,
            connectionsPerIp: 1000,
          },
        })}
      />
    );

    expect(screen.getByText("rateLimitMode")).toBeInTheDocument();
    expect(screen.getByText("Gateway default (1000 / 3000 / 1000)")).toBeInTheDocument();
    expect(screen.getByText("connectionsPerIp")).toBeInTheDocument();
  });
});
