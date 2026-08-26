import type { ForwardScheme, NodeAppearanceColor, ProxyHostType, ProxyUpstreamKind } from "@/types";

export interface ProxyUpstreamLabelInput {
  type: ProxyHostType;
  upstreamKind?: ProxyUpstreamKind;
  forwardHost: string | null;
  forwardPort: number | null;
  forwardScheme: ForwardScheme;
  dockerNodeId?: string | null;
  dockerNodeSlug?: string | null;
  dockerContainerName?: string | null;
  dockerComposeProjectId?: string | null;
  dockerComposeServiceName?: string | null;
  dockerDeploymentId?: string | null;
  dockerDeploymentName?: string | null;
  dockerNodeAppearanceColor?: NodeAppearanceColor | null;
  dockerContainerPort?: number | null;
  dockerProtocol?: "tcp" | null;
  pageTarget?: {
    projectName: string;
    projectSlug: string;
    projectAppearanceColor: NodeAppearanceColor | null;
    tagName: string;
  } | null;
}

export function proxyUpstreamResourceName(host: ProxyUpstreamLabelInput): string | null {
  if (host.type !== "proxy") return null;
  if (host.upstreamKind === "docker_container" && host.dockerContainerName) {
    return host.dockerContainerName;
  }
  if (host.upstreamKind === "docker_deployment" && host.dockerDeploymentId) {
    return host.dockerDeploymentName ?? host.dockerDeploymentId.slice(0, 8);
  }
  return null;
}

export function proxyUpstreamText(host: ProxyUpstreamLabelInput): string | null {
  if (host.type !== "proxy" || proxyUpstreamResourceName(host)) return null;
  if (!host.forwardHost) return null;
  return `${host.forwardScheme}://${host.forwardHost}${host.forwardPort ? `:${host.forwardPort}` : ""}`;
}
