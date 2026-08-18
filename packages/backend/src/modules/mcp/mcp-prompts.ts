import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasScopeBase } from '@/lib/permissions.js';

type PromptDefinition = {
  name: string;
  title: string;
  description: string;
  requiredScopes: string[];
  text: string;
};

function canAccess(scopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.some((scope) => hasScopeBase(scopes, scope));
}

function prompt(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text },
      },
    ],
  };
}

const prompts: PromptDefinition[] = [
  {
    name: 'investigate-service-outage',
    title: 'Investigate service outage',
    description: 'Triage a service outage using Gateway health, node, Docker, logging, and status data.',
    requiredScopes: ['proxy:view', 'nodes:details', 'docker:containers:view', 'logs:read', 'status-page:view'],
    text: 'Investigate the reported service outage. Start by reading the Gateway overview, then inspect relevant ingress routes, their nginx node placement, Docker targets, logs, and status page incidents allowed by this token. Summarize likely impact, evidence, and the next safest operator action without assuming permissions you do not have.',
  },
  {
    name: 'rollout-container-image',
    title: 'Roll out container image',
    description: 'Plan a Docker image rollout through existing container or blue/green deployment tools.',
    requiredScopes: ['docker:containers:manage', 'docker:images:pull'],
    text: 'Plan a controlled Docker image rollout. First identify whether the target is a regular container or a Gateway blue/green deployment. For regular containers use container image update tools; for managed blue/green deployments use deployment tools such as list_docker_deployments, get_docker_deployment, deploy_docker_deployment, switch_docker_deployment_slot, and rollback_docker_deployment. Never operate on an underlying managed deployment slot container directly. Confirm the target node, current image, desired tag, dependency risk, and rollback path, and treat recreate/update/deploy/switch operations as operationally risky actions requiring explicit operator intent.',
  },
  {
    name: 'create-status-incident',
    title: 'Create status incident',
    description: 'Draft a status page incident workflow and operator checklist.',
    requiredScopes: ['status-page:incidents:create', 'status-page:view'],
    text: 'Prepare a status page incident workflow. Identify affected services, customer-facing summary, severity, timestamps, and update cadence. Prompts do not create incidents directly; use only available Gateway tools or instruct the operator which REST action is needed.',
  },
  {
    name: 'review-node-health',
    title: 'Review node health',
    description: 'Review node fleet health and identify risky nodes.',
    requiredScopes: ['nodes:details', 'nodes:details'],
    text: 'Review Gateway node health. Read node resources and available details, group nodes by status and type, call out disconnected or stale nodes, and recommend the least invasive checks before using console or configuration-changing tools.',
  },
  {
    name: 'provision-proxy-host',
    title: 'Provision ingress route',
    description: 'Guide route provisioning with domain affinity, target, certificate, and ingress-node checks.',
    requiredScopes: ['proxy:create', 'proxy:view'],
    text: 'Guide provisioning an ingress route through the existing proxy-host tools. Verify that each registered domain is assigned to the selected nginx ingress node, then verify the target upstream, TLS requirements, existing certificates, access list needs, and health check settings. Do not invent hostnames, ports, node IDs, or certificate IDs; request missing operator-specific values.',
  },
  {
    name: 'renew-or-debug-certificate',
    title: 'Renew or debug certificate',
    description: 'Troubleshoot expiring or failed SSL certificate renewal.',
    requiredScopes: ['ssl:cert:view', 'ssl:cert:issue', 'pki:cert:view'],
    text: 'Troubleshoot certificate renewal. Read expiring certificates and related route usage, distinguish ACME SSL certificates from internal PKI certificates, verify domain coverage and challenge assumptions, and recommend renewal or replacement steps allowed by this token.',
  },
  {
    name: 'plan-managed-database-access',
    title: 'Plan managed database access',
    description: 'Plan or provision safe access to a managed database.',
    requiredScopes: ['databases:view'],
    text: 'Plan or provision access to a Gateway managed database. Discover the Databases toolset and read the databases documentation first. Use manage_managed_database: catalog before create, keep the instance private unless explicit publication is requested, poll get until ready, then create a binding for the selected container or deployment. Do not include credentials, connection URIs, binding environment variables, connector aliases, or daemon error text in the response.',
  },
];

export function registerMcpPrompts(server: McpServer, scopes: string[]): void {
  for (const definition of prompts) {
    if (!canAccess(scopes, definition.requiredScopes)) continue;
    server.registerPrompt(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
      },
      () => prompt(definition.text)
    );
  }
}
