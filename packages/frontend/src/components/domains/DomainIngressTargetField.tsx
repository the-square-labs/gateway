import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DomainIngressGroupOption, DomainNginxNodeOptions } from "@/types";

interface DomainIngressTargetFieldProps {
  nginxNodeId: string;
  ingressGroupId: string;
  onChange: (target: { nginxNodeId: string; ingressGroupId: string }) => void;
  eligibleNodes: DomainNginxNodeOptions["eligibleNodes"];
  ingressGroups: DomainIngressGroupOption[];
  loading: boolean;
  dnsProvider: "cloudflare" | "external";
}

const GROUP_PREFIX = "group:";

/** The ingress node of a new domain, or an ingress group whose members all serve it. */
export function DomainIngressTargetField({
  nginxNodeId,
  ingressGroupId,
  onChange,
  eligibleNodes,
  ingressGroups,
  loading,
  dnsProvider,
}: DomainIngressTargetFieldProps) {
  const selectedNode = eligibleNodes.find((node) => node.id === nginxNodeId);
  const selectedGroup = ingressGroups.find((group) => group.id === ingressGroupId);
  const choose = (value: string) =>
    onChange(
      value.startsWith(GROUP_PREFIX)
        ? { nginxNodeId: "", ingressGroupId: value.slice(GROUP_PREFIX.length) }
        : { nginxNodeId: value, ingressGroupId: "" }
    );

  return (
    <div className="space-y-1.5">
      <label htmlFor="add-domain-node" className="text-sm font-medium">
        Ingress node or group
      </label>
      <Select
        value={ingressGroupId ? `${GROUP_PREFIX}${ingressGroupId}` : nginxNodeId}
        onValueChange={choose}
        disabled={loading || (eligibleNodes.length === 0 && ingressGroups.length === 0)}
      >
        <SelectTrigger id="add-domain-node" aria-label="Ingress node" aria-busy={loading}>
          <SelectValue
            placeholder={
              loading
                ? "Loading nodes…"
                : eligibleNodes.length > 0 || ingressGroups.length > 0
                  ? "Select a node or group"
                  : "Unavailable"
            }
          >
            {/* Always defined: the trigger shows the name only, never the option's address. */}
            {selectedGroup
              ? `${selectedGroup.name} (ingress group)`
              : selectedNode
                ? selectedNode.displayName || selectedNode.hostname
                : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {eligibleNodes.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {node.displayName || node.hostname} · {node.effectiveAddress}
            </SelectItem>
          ))}
          {ingressGroups.map((group) => (
            <SelectItem key={group.id} value={`${GROUP_PREFIX}${group.id}`}>
              {group.name} (ingress group) ·{" "}
              {group.members.map((member) => member.effectiveAddress).join(", ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {ingressGroupId
          ? dnsProvider === "cloudflare"
            ? "DNS records list every active member's address (round robin; plain records are not health-checked)."
            : "The domain must already resolve to the members' public addresses."
          : dnsProvider === "cloudflare"
            ? "DNS records point at this node's public address."
            : "The domain must already resolve to this node's public address."}
      </p>
    </div>
  );
}
