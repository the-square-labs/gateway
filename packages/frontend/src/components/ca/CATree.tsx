import { ChevronDown, ChevronRight, Shield } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { CA } from "@/types";

interface CATreeProps {
  cas: CA[];
  onSelect: (id: string) => void;
  selectedId?: string;
}

interface CATreeNodeData extends CA {
  children: CATreeNodeData[];
}

function buildTree(cas: CA[]): CATreeNodeData[] {
  const map = new Map<string, CATreeNodeData>();
  const roots: CATreeNodeData[] = [];

  for (const ca of cas) {
    map.set(ca.id, { ...ca, children: [] });
  }

  for (const ca of cas) {
    const node = map.get(ca.id)!;
    if (ca.parentId && map.has(ca.parentId)) {
      map.get(ca.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function CATreeNodeComponent({
  ca,
  depth,
  onSelect,
  selectedId,
}: {
  ca: CATreeNodeData;
  depth: number;
  onSelect: (id: string) => void;
  selectedId?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = ca.children.length > 0;
  const isSelected = selectedId === ca.id;

  const statusColor =
    ca.status === "active"
      ? "text-success"
      : ca.status === "revoked"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div>
      {/* Tree row: selects the CA; the chevron inside toggles its children. */}
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1.5 py-1.5 text-sm hover:bg-accent/50 transition-colors text-left",
          isSelected && "bg-accent font-medium"
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px`, paddingRight: 4 }}
        onClick={() => onSelect(ca.id)}
      >
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="shrink-0 p-0.5"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            )}
          </span>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Shield className={cn("h-3 w-3 shrink-0", statusColor)} />
        <span className="truncate flex-1">{ca.commonName}</span>
        {ca.certCount > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{ca.certCount}</span>
        )}
        {ca.status !== "active" && (
          <Badge variant={ca.status === "revoked" ? "destructive" : "secondary"} size="inline">
            {ca.status}
          </Badge>
        )}
      </button>
      {hasChildren && expanded && (
        <div>
          {ca.children.map((child) => (
            <CATreeNodeComponent
              key={child.id}
              ca={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CATree({ cas, onSelect, selectedId }: CATreeProps) {
  const tree = useMemo(() => buildTree(cas || []), [cas]);

  if (tree.length === 0) {
    return null;
  }

  return (
    <div>
      {tree.map((ca) => (
        <CATreeNodeComponent
          key={ca.id}
          ca={ca}
          depth={0}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
    </div>
  );
}
