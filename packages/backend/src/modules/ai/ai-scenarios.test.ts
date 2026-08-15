import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ALL_SCOPES, isValidBaseScope } from '@/lib/scopes.js';
import type { User } from '@/types.js';
import { getAIScenario, listVisibleAIScenarios, rankAIScenarios } from './ai-scenarios.js';

const ADMIN: User = {
  id: 'user-1',
  oidcSubject: 'oidc-user-1',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [...ALL_SCOPES],
  isBlocked: false,
};

describe('AI scenarios', () => {
  it('uses only registered Gateway scopes', () => {
    const scenarios = listVisibleAIScenarios(ADMIN);

    expect(scenarios).toHaveLength(8);
    for (const scenario of scenarios) {
      expect(scenario.requiredAnyScopes.every(isValidBaseScope), scenario.id).toBe(true);
    }
  });

  it('preserves the first contextual rank when defaults repeat a scenario', () => {
    const scenarios = listVisibleAIScenarios(ADMIN);

    expect(
      rankAIScenarios(scenarios, { route: '/docker' })
        .slice(0, 2)
        .map(({ id }) => id)
    ).toEqual(['release-existing-service', 'deploy-production-application']);
    expect(rankAIScenarios(scenarios, { route: '/nodes' })[0]?.id).toBe('prepare-production-server');
  });

  it('keeps scenarios visible through any one of their valid read or create scopes', () => {
    const nodeCreator = { ...ADMIN, scopes: ['nodes:create'] };
    const scenario = getAIScenario('prepare-production-server');

    expect(scenario).not.toBeNull();
    expect(listVisibleAIScenarios(nodeCreator).map(({ id }) => id)).toContain('prepare-production-server');
  });
});
