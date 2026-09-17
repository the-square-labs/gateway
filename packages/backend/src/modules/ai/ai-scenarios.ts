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
