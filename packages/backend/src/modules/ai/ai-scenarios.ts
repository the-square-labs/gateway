import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { User } from '@/types.js';
import type { PageContext } from './ai.types.js';

export type AIScenarioCategory =
  | 'deploy_release'
  | 'migrate_recover'
  | 'infrastructure_access'
  | 'data_storage'
  | 'security_pki'
  | 'observe_operate';

export interface AIScenarioDefinition {
  id: string;
  category: AIScenarioCategory;
  title: string;
  description: string;
  icon: 'rocket' | 'refresh' | 'server' | 'database' | 'shield' | 'activity';
  requiredAnyScopes: string[];
  kickoffInstruction: string;
}

const SCENARIOS: AIScenarioDefinition[] = [
  {
    id: 'deploy-production-application',
    category: 'deploy_release',
    title: 'Deploy a production application',
    description: 'Take an application from source to a verified, public production deployment.',
    icon: 'rocket',
    requiredAnyScopes: ['docker:containers:view', 'docker:containers:manage', 'nodes:details'],
    kickoffInstruction:
      'Guide an end-to-end production deployment. Reuse existing source, registry, node, database, domain, certificate, logging, and monitoring resources where appropriate; otherwise propose their setup. Start by asking exactly one highest-value requirement question. Do not draft a plan until the required details are known. Once they are known, immediately create a practical plan without asking for a separate confirmation summary.',
  },
  {
    id: 'release-existing-service',
    category: 'deploy_release',
    title: 'Release an existing service safely',
    description: 'Prepare, release, verify, and observe a controlled service update.',
    icon: 'rocket',
    requiredAnyScopes: ['docker:containers:view', 'proxy:view', 'nodes:details'],
    kickoffInstruction:
      'Guide a safe release of an existing service: discover the current deployment and traffic path, gather the one missing release detail at a time, then plan rollout, health checks, logs, monitoring, and rollback. Ask exactly one question first and do not draft the plan before requirements are sufficient.',
  },
  {
    id: 'recover-unavailable-service',
    category: 'migrate_recover',
    title: 'Recover an unavailable service',
    description: 'Investigate impact, find the failure point, and restore service with evidence.',
    icon: 'refresh',
    requiredAnyScopes: ['proxy:view', 'docker:containers:view', 'nodes:details', 'logs:read'],
    kickoffInstruction:
      'Investigate and recover a service that is unavailable. First ask exactly one question that identifies the affected service or visible symptom. Collect read-only evidence before proposing changes; if a change is needed, switch into a Plan Mode journey and include verification and rollback.',
  },
  {
    id: 'migrate-workload',
    category: 'migrate_recover',
    title: 'Migrate a workload',
    description: 'Move an application or service with a controlled cutover and validation path.',
    icon: 'refresh',
    requiredAnyScopes: ['nodes:details', 'docker:containers:view', 'databases:view'],
    kickoffInstruction:
      'Guide a workload migration from discovery to validated cutover. Ask exactly one question to identify the source, target, and downtime tolerance. Then gather only missing requirements, plan backup or rollback, migration, traffic cutover, and verification.',
  },
  {
    id: 'prepare-production-server',
    category: 'infrastructure_access',
    title: 'Prepare a production server',
    description: 'Bring a server into a production-ready operational baseline.',
    icon: 'server',
    requiredAnyScopes: ['nodes:details', 'nodes:create'],
    kickoffInstruction:
      'Guide preparation of a production server. Ask one question first to identify the server and intended workload, then gather only missing details. Plan access, runtime, networking, observability, and readiness checks using Gateway-managed nodes when possible.',
  },
  {
    id: 'connect-data-layer',
    category: 'data_storage',
    title: 'Connect a production data layer',
    description: 'Plan the application database or storage path, access, backup, and checks.',
    icon: 'database',
    requiredAnyScopes: ['databases:view', 'docker:containers:view', 'nodes:details'],
    kickoffInstruction:
      'Guide a production data-layer setup. Ask exactly one question first about the application and data requirements. Then plan secure connectivity, persistence, backup or recovery expectations, and validation; do not create a plan before the required details are known.',
  },
  {
    id: 'secure-domain-and-certificates',
    category: 'security_pki',
    title: 'Secure a domain and certificates',
    description: 'Connect DNS, routing, TLS certificates, and verification for a public service.',
    icon: 'shield',
    requiredAnyScopes: ['domains:view', 'ssl:cert:view', 'proxy:view'],
    kickoffInstruction:
      'Guide secure publication of a service through a domain and TLS. Ask exactly one question first about the domain and target service. Identify missing DNS or provider integrations as prerequisites, then plan routing, certificate issuance, renewal, and external verification.',
  },
  {
    id: 'establish-observability',
    category: 'observe_operate',
    title: 'Establish service observability',
    description: 'Make an application observable with health checks, logs, and actionable alerts.',
    icon: 'activity',
    requiredAnyScopes: ['logs:read', 'notifications:view', 'status-page:view'],
    kickoffInstruction:
      'Guide observability for a service from the current state to useful health checks, logs, alerts, and verification. Ask exactly one question first to identify the service and its expected behaviour. Plan only after the necessary details are available.',
  },
];

export function getAIScenario(id: string): AIScenarioDefinition | null {
  return SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function listVisibleAIScenarios(user: User): AIScenarioDefinition[] {
  return SCENARIOS.filter((scenario) =>
    scenario.requiredAnyScopes.some((scope) => TokensService.hasScope(user.scopes, scope))
  );
}

export function rankAIScenarios(scenarios: AIScenarioDefinition[], context?: PageContext): AIScenarioDefinition[] {
  const route = context?.route ?? '';
  const resourceType = context?.resourceType ?? '';
  const preferredIds = [
    ...(route.includes('/domains') || route.includes('/ssl') || resourceType === 'domain'
      ? ['secure-domain-and-certificates']
      : []),
    ...(route.includes('/docker') || resourceType === 'docker_container'
      ? ['release-existing-service', 'deploy-production-application']
      : []),
    ...(route.includes('/database') || resourceType === 'database' ? ['connect-data-layer'] : []),
    ...(route.includes('/nodes') || resourceType === 'node' ? ['prepare-production-server'] : []),
    ...['deploy-production-application', 'recover-unavailable-service', 'prepare-production-server'],
  ];
  const rank = new Map<string, number>();
  for (const id of preferredIds) {
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  return [...scenarios].sort((left, right) => (rank.get(left.id) ?? 100) - (rank.get(right.id) ?? 100));
}
