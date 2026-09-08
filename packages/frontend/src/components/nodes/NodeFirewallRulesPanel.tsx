import { Pencil, Plus, Trash2 } from "lucide-react";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { HostingFirewallDirection, HostingFirewallRule } from "@/types/hosting";

export interface NodeFirewallRulesPanelProps {
  direction: HostingFirewallDirection;
  rules: HostingFirewallRule[];
  editingLocked: boolean;
  onAdd: (direction: HostingFirewallDirection) => void;
  onEdit: (rule: HostingFirewallRule) => void;
  onDelete: (rule: HostingFirewallRule) => void;
}

export function NodeFirewallRulesPanel({
  direction,
  rules,
  editingLocked,
  onAdd,
  onEdit,
  onDelete,
}: NodeFirewallRulesPanelProps) {
  const inbound = direction === "in";
  const columns: SimpleTableColumn<HostingFirewallRule>[] = [
    {
      id: "action",
      header: "Action",
      render: (rule) => (
        <Badge variant={rule.action === "deny" ? "destructive" : "success"} size="inline">
          {rule.action}
        </Badge>
      ),
    },
    { id: "protocol", header: "Protocol", render: (rule) => rule.protocol.toUpperCase() },
    { id: "ports", header: "Ports", render: (rule) => rule.ports },
    {
      id: "addresses",
      header: inbound ? "Source addresses" : "Destination addresses",
      render: (rule) => <span className="break-words">{rule.addresses.join(", ")}</span>,
    },
    { id: "comment", header: "Comment", render: (rule) => rule.description || "—" },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      render: (rule) => (
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${inbound ? "inbound" : "outbound"} firewall rule`}
            disabled={editingLocked}
            onClick={() => onEdit(rule)}
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${inbound ? "inbound" : "outbound"} firewall rule`}
            disabled={editingLocked}
            onClick={() => onDelete(rule)}
          >
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PanelShell
      title={inbound ? "Inbound rules" : "Outbound rules"}
      description="Rules are retained when the firewall is disabled. The selected default policy applies when no rule matches."
      actions={
        <Button
          type="button"
          variant="outline"
          aria-label={`Add ${inbound ? "inbound" : "outbound"} firewall rule`}
          disabled={editingLocked}
          onClick={() => onAdd(direction)}
        >
          <Plus /> Add rule
        </Button>
      }
    >
      <SimpleTable
        columns={columns}
        rows={rules}
        getRowKey={(rule) => rule.id}
        emptyMessage={
          inbound
            ? "No inbound rules. The default inbound policy applies."
            : "No outbound rules. The default outbound policy applies."
        }
      />
    </PanelShell>
  );
}
