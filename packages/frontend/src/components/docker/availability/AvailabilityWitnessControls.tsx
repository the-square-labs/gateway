import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DashboardRelayInstance, Node } from "@/types";

const AUTO_VALUE = "auto";

/**
 * Witness selector for the Availability policy form, next to partitionMode: automatic (farthest by
 * latency) or an explicit relay instance / node that is not already a candidate of this policy.
 */
export function AvailabilityWitnessControls({
  nodes,
  relayInstances,
  candidateNodeIds,
  witness,
  onWitnessChange,
  disabled,
}: {
  nodes: Node[];
  relayInstances: DashboardRelayInstance[];
  candidateNodeIds: Set<string>;
  witness: string | null;
  onWitnessChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const eligibleNodes = nodes.filter((node) => !candidateNodeIds.has(node.id));

  return (
    <SettingsControlRow
      title="Witness"
      description="A relay or node outside this policy that breaks ties during a network partition."
      help="Auto picks the eligible member with the largest minimum latency to every candidate, which is least likely to share a site with any of them. Set an explicit relay instance or node to override the automatic choice; the API validates eligibility."
    >
      <Select
        value={witness ?? AUTO_VALUE}
        onValueChange={(value) => onWitnessChange(value === AUTO_VALUE ? null : value)}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Witness">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            value={AUTO_VALUE}
            description="Eligible member with the largest minimum RTT."
          >
            Auto (farthest by latency)
          </SelectItem>
          {relayInstances.map((instance) => (
            <SelectItem key={instance.id} value={instance.id} description="Relay instance">
              {instance.displayName}
            </SelectItem>
          ))}
          {eligibleNodes.map((node) => (
            <SelectItem key={node.id} value={node.id} description="Node">
              {node.displayName || node.hostname || node.slug}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsControlRow>
  );
}
