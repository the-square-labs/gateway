import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AI_TOOLS,
  getOpenAITools,
  inferDiscoveredToolsetsFromText,
  isBaseAIToolName,
  isDestructiveTool,
  TOOL_STORE_INVALIDATION_MAP,
} from '@/modules/ai/ai.tools.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const allRequiredScopes = [
  ...new Set(
    AI_TOOLS.flatMap((tool) => [tool.requiredScope, ...(tool.requiredScopes ?? [])]).filter((scope): scope is string =>
      Boolean(scope)
    )
  ),
];

const openToolNames = (
  webSearchEnabled: boolean,
  options?: { discoveredToolsets?: string[]; sandboxEnabled?: boolean; planningMode?: boolean }
) => getOpenAITools([], allRequiredScopes, webSearchEnabled, options).map((tool) => tool.function.name);

describe('AI tool registry characterization', () => {
  it('preserves the Community tool registry after removing 9 planning and 11 sandbox tools', () => {
    const categoryCounts = AI_TOOLS.reduce<Record<string, number>>((counts, tool) => {
      counts[tool.category] = (counts[tool.category] ?? 0) + 1;
      return counts;
    }, {});
    const summary = {
      count: AI_TOOLS.length,
      digest: digest(AI_TOOLS),
      categoryCounts,
      destructive: {
        count: AI_TOOLS.filter((tool) => tool.destructive).length,
        digest: digest(AI_TOOLS.filter((tool) => tool.destructive).map((tool) => tool.name)),
      },
      invalidationMapDigest: digest(TOOL_STORE_INVALIDATION_MAP),
    };

    expect(summary).toEqual({
      count: 236,
      digest: '6c28a4b13b330c07e6af1c674892479709aa2756dca9ceaf5e96aec09bd83d83',
      categoryCounts: {
        Discovery: 6,
        Artifact: 2,
        Interaction: 3,
        'Conversation Retrieval': 5,
        'PKI - System Audit': 1,
        'PKI - Certificate Authorities': 6,
        'PKI - Certificates': 5,
        'PKI - Templates': 4,
        Folders: 2,
        Ingress: 15,
        'SSL Certificates': 4,
        Domains: 4,
        'Access Lists': 4,
        Nodes: 8,
        Administration: 12,
        'AI Workspace': 4,
        Conversations: 1,
        OAuth: 1,
        Settings: 1,
        Maintenance: 6,
        Dashboard: 1,
        Setup: 2,
        Documentation: 2,
        Docker: 38,
        Databases: 12,
        Storage: 6,
        GitLab: 26,
        GitHub: 12,
        Git: 6,
        Cloudflare: 1,
        Inference: 4,
        Logging: 1,
        'Status Page': 1,
        Pages: 2,
        'Managed Databases': 1,
        'Docker Migration': 1,
        'Logging Backend': 1,
        'External SSH': 3,
        Notifications: 21,
        'Web Search': 1,
      },
      destructive: {
        count: 134,
        digest: '5454e0e9d0183ae757e511156336d667cbd17ed76385d2ace8de7be862e4cb88',
      },
      invalidationMapDigest: '8e085cf6d990249d5a3b196675af430bc20e8fed576341f4b601bc5f64ea974d',
    });
    expect(new Set(AI_TOOLS.map((tool) => tool.name)).size).toBe(AI_TOOLS.length);
  });

  it('preserves OpenAI tool projection and filtering matrices', () => {
    const matrix = {
      allDefault: openToolNames(false),
      allCapabilities: openToolNames(true, { sandboxEnabled: true }),
      discoveredIngressDocker: openToolNames(true, {
        discoveredToolsets: ['Ingress', 'Docker'],
        sandboxEnabled: true,
      }),
      planningMode: openToolNames(true, { planningMode: true, sandboxEnabled: true }),
    };

    expect(
      Object.fromEntries(
        Object.entries(matrix).map(([key, names]) => [key, { count: names.length, digest: digest(names) }])
      )
    ).toEqual({
      allDefault: {
        count: 232,
        digest: '7021c4f3964dfa3a4192d35a8b5dc1b7dd76e900fc243a806b454c20630d47bc',
      },
      allCapabilities: {
        count: 233,
        digest: 'b552a6ebd47ee4fef835e2c17234f0a9b185d4fda7469187ae0028375f16701b',
      },
      discoveredIngressDocker: {
        count: 71,
        digest: '57b6846b955cdc3ff79b04647c0859d1e586e0d3d5d800e5564b91c78d74955d',
      },
      planningMode: {
        count: 131,
        digest: 'd676753f94215b539f348672906ab95d9c1a749322846be7163afcd3cd7ff395',
      },
    });
    expect(matrix.allDefault).not.toContain('web_search');
    expect(matrix.allCapabilities).toContain('web_search');
  });

  it('preserves discovery matching across exact, readable, bounded, and escaped names', () => {
    const cases = {
      exact: inferDiscoveredToolsetsFromText('Please call create_route and list_docker_containers.'),
      readable: inferDiscoveredToolsetsFromText('Please create route and list docker containers.'),
      bounded: inferDiscoveredToolsetsFromText('create_route_suffix should not activate anything.'),
      punctuation: inferDiscoveredToolsetsFromText('Use manage_ssl_certificate, then manage_domain.'),
      baseOnly: inferDiscoveredToolsetsFromText('Use discover_tools and ask_question.'),
    };

    expect(cases).toEqual({
      exact: ['Docker', 'Ingress'],
      readable: ['Docker', 'Ingress'],
      bounded: [],
      punctuation: ['Domains', 'SSL Certificates'],
      baseOnly: [],
    });
    expect(cases.exact).toEqual(cases.readable);
  });

  it('preserves base and destructive lookup behavior', () => {
    expect({
      base: ['discover_tools', 'ask_question', 'web_search'].map(isBaseAIToolName),
      nonBase: ['create_route', 'manage_database', 'run_process'].map(isBaseAIToolName),
      destructive: ['create_route', 'delete_route', 'manage_database', 'run_process'].map(isDestructiveTool),
      unknown: {
        base: isBaseAIToolName('unknown_tool'),
        destructive: isDestructiveTool('unknown_tool'),
      },
    }).toEqual({
      base: [true, true, true],
      nonBase: [false, false, false],
      destructive: [true, true, false, false],
      unknown: { base: false, destructive: false },
    });
  });
});
