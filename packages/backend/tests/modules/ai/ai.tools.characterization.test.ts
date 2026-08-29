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
  it('preserves the complete tool registry, ordering, and category topology', () => {
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
      count: 249,
      digest: '2692cd698aab5a6d5fc7ffb20eaf73b1a10dbebe1067a48b9220669ce150d40a',
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
        Databases: 11,
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
        Sandbox: 11,
        'External SSH': 3,
        Notifications: 21,
        'Web Search': 1,
        Planning: 9,
      },
      destructive: {
        count: 133,
        digest: 'ce0c79e62afc96f73e20f455c15ac51e3cf45f7364cf18886a5cee2d6fd856f3',
      },
      invalidationMapDigest: '64dc9ba1ebe5e4a5e4b86985714fb88a42ad432acce97ddc3bf93264f58d94a7',
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
        count: 235,
        digest: 'b5ae07dfb7efb3edb7d96c9b190566791240f1c50f9fb632e589b3e7288f3652',
      },
      allCapabilities: {
        count: 247,
        digest: '54c06ce8a99eec0d422bfda34347e0359247b431e8595f36cfbafd53e8d023d7',
      },
      discoveredIngressDocker: {
        count: 81,
        digest: '1cc98bc5ffd014cac4fac12e1257186d450580fa199893cbf158c003fcfa33de',
      },
      planningMode: {
        count: 140,
        digest: '7a694f0466966d145d9af6b3d903770e5381c77b684fcbf1e428126296134528',
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
      destructive: [true, true, false, true],
      unknown: { base: false, destructive: false },
    });
  });
});
