import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DockerAvailabilityPlacement, Node } from "@/types";

export const ALL_AVAILABILITY_INSTANCES = "__all__";

export function AvailabilityInstanceSelect({
  placements,
  nodes,
  value,
  onValueChange,
  includeAll = false,
}: {
  placements: DockerAvailabilityPlacement[];
  nodes: Node[];
  value: string;
  onValueChange: (value: string) => void;
  includeAll?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Runtime instance" className="w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value={ALL_AVAILABILITY_INSTANCES}>All instances</SelectItem>}
        {placements.map((placement) => {
          const node = nodes.find((candidate) => candidate.id === placement.nodeId);
          return (
            <SelectItem key={placement.id} value={placement.id}>
              {node?.displayName || node?.hostname || node?.slug || placement.nodeId.slice(0, 8)}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
