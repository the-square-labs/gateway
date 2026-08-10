import { describe, expect, it } from 'vitest';
import {
  appendAIResourceReferencesToModelResult,
  extractAIResourceReferences,
  formatAIResourceMarker,
  mergeAIResourceReference,
  referencedAIResourceIds,
  stripAIResourceMarkers,
} from './ai-resource-references.js';

describe('AI resource references', () => {
  it('extracts searchable resources and their Docker node context', () => {
    const references = extractAIResourceReferences(
      'find_resource',
      { query: 'api' },
      {
        results: [
          {
            type: 'docker_container',
            id: 'container-1',
            name: 'api',
            nodeId: 'node-1',
            nodeSlug: 'docker-src',
            summary: {},
          },
        ],
      }
    );

    expect(references).toEqual([
      expect.objectContaining({
        refId: expect.stringMatching(/^gwr_[a-f0-9]{24}$/),
        type: 'docker_container',
        resourceId: 'api',
        label: 'api',
        nodeId: 'node-1',
        nodeSlug: 'docker-src',
        relation: 'read',
      }),
      expect.objectContaining({ type: 'node', resourceId: 'node-1', label: 'docker-src', slug: 'docker-src' }),
    ]);
  });

  it('extracts a created Docker container and stable node reference', () => {
    const references = extractAIResourceReferences(
      'create_docker_container',
      { nodeId: 'node-1', name: 'ai-e2e-restart' },
      { success: true, data: { id: 'container-1', name: 'ai-e2e-restart', state: 'running' } },
      { nodeSlug: 'docker-src', nodeLabel: 'Docker source' }
    );

    expect(references).toEqual([
      expect.objectContaining({
        type: 'docker_container',
        resourceId: 'ai-e2e-restart',
        label: 'ai-e2e-restart',
        nodeSlug: 'docker-src',
        relation: 'created',
      }),
      expect.objectContaining({ type: 'node', resourceId: 'node-1', label: 'Docker source' }),
    ]);
  });

  it('uses the canonical Docker inspect name instead of the volatile container id', () => {
    const references = extractAIResourceReferences(
      'get_docker_container',
      { nodeId: 'node-1', containerId: '527b02985e9b37cf9252b29f01de321f' },
      { Id: '527b02985e9b37cf9252b29f01de321f', Name: '/ai-e2e-restart' },
      { nodeSlug: 'docker-src' }
    );

    expect(references[0]).toMatchObject({
      type: 'docker_container',
      resourceId: 'ai-e2e-restart',
      label: 'ai-e2e-restart',
      nodeSlug: 'docker-src',
    });
  });

  it('does not let a later container id fallback replace a canonical container label', () => {
    const canonical = extractAIResourceReferences(
      'get_docker_container',
      { nodeId: 'node-1', containerId: '527b02985e9b37cf9252b29f01de321f' },
      { Id: '527b02985e9b37cf9252b29f01de321f', Name: '/ai-e2e-restart' },
      { nodeSlug: 'docker-src' }
    )[0];
    const fallback = extractAIResourceReferences(
      'execute_docker_container_console_command',
      { nodeId: 'node-1', containerId: '527b02985e9b37cf9252b29f01de321f' },
      { stdout: 'ok' },
      { nodeSlug: 'docker-src' }
    )[0];

    expect(mergeAIResourceReference(canonical, fallback)).toMatchObject({
      label: 'ai-e2e-restart',
      relation: 'verified',
      nodeSlug: 'docker-src',
    });
  });

  it('carries a resolved node appearance color only on the node reference', () => {
    const references = extractAIResourceReferences(
      'get_docker_container',
      { nodeId: 'node-1', containerId: 'container-1' },
      { Id: 'container-1', Name: '/api' },
      { nodeSlug: 'docker-src', nodeAppearanceColor: 'orange' }
    );

    expect(references[0]?.appearanceColor).toBeUndefined();
    expect(references[1]).toMatchObject({
      type: 'node',
      resourceId: 'node-1',
      appearanceColor: 'orange',
    });
  });

  it('uses resolved node presentation instead of exposing node UUID as the label', () => {
    const references = extractAIResourceReferences(
      'execute_node_console_command',
      { nodeId: '44f89908-ea0d-43e6-bdd2-2c5c0637cf53' },
      { stdout: 'HTTP_CODE=200' },
      { nodeSlug: 'docker-src', nodeLabel: 'docker-src', nodeAppearanceColor: 'yellow' }
    );

    expect(references[0]).toMatchObject({
      type: 'node',
      resourceId: '44f89908-ea0d-43e6-bdd2-2c5c0637cf53',
      label: 'docker-src',
      slug: 'docker-src',
      relation: 'verified',
      appearanceColor: 'yellow',
    });
  });

  it('adds model-only markers without changing primitive meaning', () => {
    const [reference] = extractAIResourceReferences(
      'manage_docker_volume',
      { operation: 'create', nodeId: 'node-1', name: 'data' },
      { name: 'data' },
      { nodeSlug: 'docker-src' }
    );
    const output = appendAIResourceReferencesToModelResult({ name: 'data' }, [reference]) as Record<string, unknown>;
    expect(output.name).toBe('data');
    expect(output.gatewayResourceReferences).toEqual([
      expect.objectContaining({ marker: formatAIResourceMarker(reference), label: 'data' }),
    ]);
  });

  it('parses ids and strips marker syntax to safe fallback labels', () => {
    const text =
      'Updated [[resource:gwr_0123456789abcdef01234567|API container]] on [[resource:gwr_fedcba9876543210fedcba98|docker-src]].';
    expect(referencedAIResourceIds(text)).toEqual(['gwr_0123456789abcdef01234567', 'gwr_fedcba9876543210fedcba98']);
    expect(stripAIResourceMarkers(text)).toBe('Updated API container on docker-src.');
  });

  it('does not manufacture references for broad list tools', () => {
    expect(extractAIResourceReferences('list_docker_containers', { nodeId: 'node-1' }, [{ id: 'c1' }])).toEqual([]);
  });

  it('does not misclassify external GitLab project webhooks as Gateway resources', () => {
    expect(
      extractAIResourceReferences(
        'gitlab_create_or_update_project_webhook',
        { projectId: '42' },
        { id: 12, url: 'https://example.test/hook' }
      )
    ).toEqual([]);
  });

  it('extracts direct PKI template mutations', () => {
    const references = extractAIResourceReferences(
      'create_template',
      { name: 'service-leaf' },
      { id: 'template-1', name: 'service-leaf' }
    );

    expect(references).toEqual([
      expect.objectContaining({
        type: 'pki_template',
        resourceId: 'template-1',
        label: 'service-leaf',
        relation: 'created',
      }),
    ]);
  });
});
