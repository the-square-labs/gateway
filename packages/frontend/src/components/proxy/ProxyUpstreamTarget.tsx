import { Box } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { getNodeAppearanceColor } from "@/lib/node-appearance";
import {
  type ProxyUpstreamLabelInput,
  proxyUpstreamResourceName,
  proxyUpstreamText,
} from "@/lib/proxy-upstream-label";
import { dockerContainerRoute, dockerDeploymentRoute } from "@/lib/resource-routes";
import { useDockerStore } from "@/stores/docker";

export function ProxyUpstreamTarget({
  host,
  size,
  linkToResource = false,
}: {
  host: ProxyUpstreamLabelInput;
  size?: BadgeProps["size"];
  linkToResource?: boolean;
}) {
  const dockerNodeSlug = useDockerStore(
    (state) => state.dockerNodes.find((node) => node.id === host.dockerNodeId)?.slug
  );
  const resourceName = proxyUpstreamResourceName(host);
  if (resourceName) {
    const appearance = getNodeAppearanceColor(host.dockerNodeAppearanceColor);
    const badge = (
      <Badge
        variant="secondary"
        size={size}
        className={appearance?.badgeClassName}
        title={resourceName}
      >
        <Box className="mr-1.5 h-3.5 w-3.5" />
        {resourceName}
      </Badge>
    );
    const nodeSlug = host.dockerNodeSlug ?? dockerNodeSlug;
    const targetPath =
      linkToResource && nodeSlug && host.upstreamKind === "docker_container"
        ? dockerContainerRoute(nodeSlug, resourceName)
        : linkToResource &&
            nodeSlug &&
            host.upstreamKind === "docker_deployment" &&
            host.dockerDeploymentName
          ? dockerDeploymentRoute(nodeSlug, host.dockerDeploymentName)
          : null;
    return targetPath ? <Link to={targetPath}>{badge}</Link> : badge;
  }

  const text = proxyUpstreamText(host);
  return text ? <span>{text}</span> : null;
}
