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
      count: 255,
      digest: 'b099e840bb693cf01e96c51feee3284d624d7116fe2733263352154f2e274adb',
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
        Storage: 5,
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
        count: 137,
        digest: '4780f1f9c12629c169c86f07425a3c528b98994219ad3775ec5b95ad9fd91fd8',
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
        count: 241,
        digest: '2b0a39f624c366f2d4a8f456611d1d187d9854f6db55cb72075a302b91aa4363',
      },
      allCapabilities: {
        count: 253,
        digest: '59e5488913837ac7b81c044a8ed4da7ee5e1a2e89160c41905d814ddab9cdeed',
      },
      discoveredIngressDocker: {
        count: 81,
        digest: '1cc98bc5ffd014cac4fac12e1257186d450580fa199893cbf158c003fcfa33de',
      },
      planningMode: {
        count: 145,
        digest: '5264e85940663736a919d324f4224f888e2cd717a0c68a2585f6d3de343055f2',
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
