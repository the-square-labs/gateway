import { useLocation } from "react-router-dom";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import type { QuickAction } from "@/types/ai";
import { useInferenceQuotaSnapshot } from "./InferenceQuotaStatus";

const QUICK_ACTIONS: Record<string, QuickAction[]> = {
  "/": [
    { label: "System overview", prompt: "Give me an overview of the system status" },
    { label: "Expiring soon", prompt: "Show certificates expiring in the next 30 days" },
    { label: "Health summary", prompt: "What's the health status of all proxy hosts?" },
  ],
  "/cas": [
    { label: "List all CAs", prompt: "List all Certificate Authorities" },
    { label: "Create root CA", prompt: "Help me create a new root CA" },
    { label: "CA hierarchy", prompt: "Show me the CA hierarchy tree" },
  ],
  "/certificates": [
    { label: "Expiring soon", prompt: "Show certificates expiring in the next 30 days" },
    { label: "Issue certificate", prompt: "Help me issue a new certificate" },
    { label: "Revoked certs", prompt: "List all revoked certificates" },
  ],
  "/proxy-hosts": [
    { label: "List all hosts", prompt: "List all proxy hosts with their status" },
    { label: "Create proxy host", prompt: "Help me create a new proxy host" },
    { label: "Unhealthy hosts", prompt: "Show proxy hosts that are offline or degraded" },
  ],
  "/ssl-certificates": [
    { label: "List SSL certs", prompt: "List all SSL certificates with expiry dates" },
    { label: "Request ACME cert", prompt: "Help me request a new Let's Encrypt certificate" },
    { label: "Expiring SSL", prompt: "Show SSL certificates expiring soon" },
  ],
  "/domains": [
    { label: "DNS status", prompt: "Show the DNS verification status of all domains" },
    { label: "Add domain", prompt: "Help me register a new domain" },
  ],
  "/templates": [
    { label: "List templates", prompt: "Show all certificate templates" },
    { label: "Create template", prompt: "Help me create a new certificate template" },
  ],
  "/administration": [
    { label: "List users", prompt: "List all users with their roles" },
    { label: "User activity", prompt: "Show recent audit log activity" },
    { label: "Recent activity", prompt: "Show the last 20 audit log entries" },
    { label: "AI actions", prompt: "Show audit log entries from AI Workspace actions" },
  ],
  "/settings": [{ label: "System info", prompt: "Show system information and statistics" }],
  "/docker/containers": [
    { label: "List containers", prompt: "List all Docker containers across all nodes" },
    { label: "Container status", prompt: "Show a summary of running and stopped containers" },
  ],
  "/docker/images": [{ label: "List images", prompt: "List all Docker images" }],
  "/docker/volumes": [{ label: "List volumes", prompt: "List all Docker volumes" }],
  "/docker/networks": [{ label: "List networks", prompt: "List all Docker networks" }],
};

const DEFAULT_ACTIONS: QuickAction[] = [
  { label: "System overview", prompt: "Give me an overview of the system" },
  { label: "Help", prompt: "What can you help me with?" },
];

interface QuickActionChipsProps {
  onSelect: (prompt: string) => void;
}

export function QuickActionChips({ onSelect }: QuickActionChipsProps) {
  const location = useLocation();
  const gatewayInferenceMode = useAIStore(
    (state) => state.providerStatus?.providerType === "gateway_inference"
  );
  const canViewInferenceUsage = useAuthStore((state) =>
    state.hasScope("inference:usage:view:self")
  );
  const inferenceQuota = useInferenceQuotaSnapshot(gatewayInferenceMode && canViewInferenceUsage);

  const actions =
    QUICK_ACTIONS[location.pathname] ||
    QUICK_ACTIONS[location.pathname.replace(/\/[^/]+$/, "")] ||
    DEFAULT_ACTIONS;

  return (
    <div className="flex flex-wrap justify-center gap-1.5 px-3 py-3">
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onSelect(action.prompt)}
          disabled={inferenceQuota.exhausted}
          className="border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
