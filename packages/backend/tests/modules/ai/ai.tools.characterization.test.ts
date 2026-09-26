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
      count: 259,
      digest: 'ea8d7a16e52b1061a10b8161975d70423a6210ffa746b0d0509a46a13db27382',
      categoryCounts: {
        Discovery: 7,
        Artifact: 2,
        Interaction: 3,
        'Conversation Retrieval': 5,
        'PKI - System Audit': 1,
        'PKI - Certificate Authorities': 6,
        'PKI - Certificates': 5,
        'PKI - Templates': 4,
        Folders: 2,
        Ingress: 18,
        'SSL Certificates': 4,
        Domains: 4,
        'Access Lists': 4,
        Nodes: 10,
        Administration: 14,
        'AI Workspace': 4,
        Conversations: 1,
        OAuth: 1,
        Settings: 1,
        Maintenance: 7,
        Dashboard: 1,
        Setup: 2,
        Documentation: 2,
        Docker: 46,
        Databases: 12,
        Storage: 6,
        GitLab: 26,
        GitHub: 12,
        Git: 6,
        Cloudflare: 1,
        Integrations: 3,
        Inference: 5,
        Logging: 1,
        'Status Page': 1,
        Pages: 2,
        'Managed Databases': 1,
        'Docker Migration': 1,
        'Logging Backend': 1,
        'External SSH': 3,
        Hosting: 1,
        Notifications: 22,
        'Web Search': 1,
      },
      destructive: {
        count: 151,
        digest: 'a5b9f9ee31006b5e12f805fd64820fa359a1e52f2bfe2dc8e24dadbadf4b2ff1',
      },
      invalidationMapDigest: '34356f6f7784946e7ce4ee6555f660a544a55a8bfe8a3a1fb5039d6595cdd3a1',
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
        count: 253,
        digest: 'eb29dbe632dbe83f0e8e71fd1f95a9663012aac0d6d7ee6847d4f6e902180161',
      },
      allCapabilities: {
        count: 254,
        digest: 'af77941a089e7f11eed524680f5962557308d5632df3b1ad0f7444b926d3fd6b',
      },
      discoveredIngressDocker: {
        count: 81,
        digest: 'c82d3678904eef7394c53217c27dcb6d30c3b2e07f983d1ee9a27422bcc59e5f',
      },
      planningMode: {
        count: 148,
        digest: '92b4321eddafb73879491b9d24b38cff4712418624a7092d9f830bd5096847af',
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
