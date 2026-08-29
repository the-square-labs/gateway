export const PLATFORM_TOKEN_SCOPES = [
  // Housekeeping
  {
    value: "housekeeping:view",
    label: "View Housekeeping",
    desc: "View housekeeping configuration, stats, and run history",
    group: "Housekeeping",
  },
  {
    value: "housekeeping:run",
    label: "Run Housekeeping",
    desc: "Manually run housekeeping tasks",
    group: "Housekeeping",
  },
  {
    value: "housekeeping:configure",
    label: "Configure Housekeeping",
    desc: "Edit housekeeping configuration and schedule",
    group: "Housekeeping",
  },
  // Licensing
  {
    value: "license:view",
    label: "View License",
    desc: "View Gateway license status and entitlement details",
    group: "Licensing",
  },
  {
    value: "license:manage",
    label: "Manage License",
    desc: "Activate, update, or remove the Gateway license",
    group: "Licensing",
  },
  // Notifications
  {
    value: "notifications:alerts:view",
    label: "View Alert Rules",
    desc: "View notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:alerts:create",
    label: "Create Alert Rules",
    desc: "Create notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:alerts:edit",
    label: "Edit Alert Rules",
    desc: "Edit notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:alerts:delete",
    label: "Delete Alert Rules",
    desc: "Delete notification alert rules",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:view",
    label: "View Webhooks",
    desc: "View notification webhooks",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:create",
    label: "Create Webhooks",
    desc: "Create notification webhooks",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:edit",
    label: "Edit Webhooks",
    desc: "Edit notification webhooks",
    group: "Notifications",
  },
  {
    value: "notifications:webhooks:delete",
    label: "Delete Webhooks",
    desc: "Delete notification webhooks",
    group: "Notifications",
  },
  {
    value: "notifications:deliveries:view",
    label: "View Delivery Logs",
    desc: "View webhook delivery attempts",
    group: "Notifications",
  },
  {
    value: "notifications:view",
    label: "View Notifications",
    desc: "Read notification resources across alerts, webhooks, and deliveries",
    group: "Notifications",
  },
  {
    value: "notifications:manage",
    label: "Manage Notifications",
    desc: "Full management access to alerts, webhooks, and deliveries",
    group: "Notifications",
  },
  // Status Page
  {
    value: "status-page:view",
    label: "View Status Page",
    desc: "View status page configuration, exposed services, incidents, and preview",
    group: "Status Page",
  },
  {
    value: "status-page:manage",
    label: "Manage Status Page",
    desc: "Edit status page settings and exposed services",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:create",
    label: "Create Incidents",
    desc: "Create manual incidents and promote automatic incidents",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:update",
    label: "Update Incidents",
    desc: "Edit incident details and post incident timeline updates",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:resolve",
    label: "Resolve Incidents",
    desc: "Resolve active status page incidents",
    group: "Status Page",
  },
  {
    value: "status-page:incidents:delete",
    label: "Delete Past Incidents",
    desc: "Delete resolved status page incidents",
    group: "Status Page",
  },
  // Features
  {
    value: "ai:workspace:use",
    label: "Use AI Workspace",
    desc: "Use the AI Workspace interface and embedded assistant",
    group: "Features",
  },
  {
    value: "feat:ai:use",
    label: "Use Gateway Inference",
    desc: "Use Gateway Inference and view personal inference usage",
    group: "Features",
  },
  {
    value: "feat:ai:configure",
    label: "Configure AI",
    desc: "Configure AI settings and providers",
    group: "Features",
  },
  {
    value: "ai:skills:manage",
    label: "Manage AI Skills",
    desc: "Create, edit, enable, disable, and delete AI Workspace skills",
    group: "Features",
  },
  {
    value: "ai:sandbox:use",
    label: "Use Sandbox Runner",
    desc: "Run bounded AI sandbox jobs",
    group: "Features",
  },
  {
    value: "ai:sandbox:tier:medium",
    label: "Use Medium Sandbox Tier",
    desc: "Run AI sandbox jobs with medium resource limits",
    group: "Features",
  },
  {
    value: "ai:sandbox:tier:high",
    label: "Use High Sandbox Tier",
    desc: "Run AI sandbox jobs with high resource limits",
    group: "Features",
  },
  {
    value: "ai:sandbox:manage",
    label: "Manage Sandbox Jobs",
    desc: "View and kill AI sandbox jobs",
    group: "Features",
  },
  {
    value: "mcp:use",
    label: "Use MCP",
    desc: "Allow this user account to access the remote MCP server with OAuth",
    group: "Features",
  },
  // Inference administration. inference:setup is an OAuth-only protocol
  // scope rendered by OAuthConsent and must not be user-assignable.
  {
    value: "inference:providers:view",
    label: "View Inference Providers",
    desc: "View inference providers, connections, discovery, and quota",
    group: "Inference",
  },
  {
    value: "inference:providers:manage",
    label: "Manage Inference Providers",
    desc: "Connect, update, synchronize, route, and disconnect inference providers",
    group: "Inference",
  },
  {
    value: "inference:models:manage",
    label: "Manage Inference Models",
    desc: "Create, publish, replace, and delete inference models",
    group: "Inference",
  },
  {
    value: "inference:limits:manage",
    label: "Manage Inference Limits",
    desc: "Configure default and per-user inference budgets",
    group: "Inference",
  },
  {
    value: "inference:usage:view",
    label: "View Inference Usage",
    desc: "View system-wide and per-user inference usage",
    group: "Inference",
  },
] as const;
