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
      count: 244,
      digest: '3c3f38accc25d6ce88c068dc07634b0d3539f210bbc66ec23288a28b450fb99d',
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
        Ingress: 16,
        'SSL Certificates': 4,
        Domains: 4,
        'Access Lists': 4,
        Nodes: 9,
        Administration: 13,
        'AI Workspace': 4,
        Conversations: 1,
        OAuth: 1,
        Settings: 1,
        Maintenance: 6,
        Dashboard: 1,
        Setup: 2,
        Documentation: 2,
        Docker: 41,
        Databases: 12,
        Storage: 6,
        GitLab: 26,
        GitHub: 12,
        Git: 6,
        Cloudflare: 1,
        Integrations: 2,
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
        count: 140,
        digest: 'ceab54396256626bec9973cf4a68e389114f05172b1a253e442a2b0d1a2ffcf1',
      },
      invalidationMapDigest: 'e82d59902d0f26c22f9568a1393d72abaddb079925fe6c51fe74ac5412f2f062',
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
        count: 240,
        digest: '77c43150516c92aae6fe0279ce55a1cde3ade9aa032a10470d6629d244d1df35',
      },
      allCapabilities: {
        count: 241,
        digest: '8ce9d4fc09bfd9fc76338348e5c9714f00c9e1c28ad4b168894e281e152c86b8',
      },
      discoveredIngressDocker: {
        count: 75,
        digest: '316e4bb28777e0e21b45ef02ed4f9fa7802ea5626e24c8b7fb8da1d7780ca53f',
      },
      planningMode: {
        count: 133,
        digest: 'b8cbbfae9a38d5d54e125a94ada3d13a05d0577cfb2e5f43f5c440904125bf51',
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
