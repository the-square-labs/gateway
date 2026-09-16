import { describe, expect, it } from 'vitest';
import { DOC_TOPIC_SCOPES, getInternalDocumentation, INTERNAL_DOCS } from './ai.docs.js';
import { CONTROL_AI_TOOLS } from './ai.tools.control.js';

function topicEnum(toolName: string): string[] {
  const tool = CONTROL_AI_TOOLS.find((candidate) => candidate.name === toolName);
  const parameters = tool?.parameters as { properties?: { topic?: { enum?: unknown } } } | undefined;
  return Array.isArray(parameters?.properties?.topic?.enum) ? (parameters.properties.topic.enum as string[]) : [];
}

describe('internal documentation parity', () => {
  it('maps the storage topic to storage:view and exposes the same topic set through both docs tools', () => {
    const expectedTopics = Object.keys(INTERNAL_DOCS);
    const sortedTopics = [...expectedTopics].sort();

    expect(DOC_TOPIC_SCOPES.storage).toBe('storage:view');
    expect(Object.keys(DOC_TOPIC_SCOPES).sort()).toEqual(sortedTopics);
    expect(topicEnum('internal_documentation').sort()).toEqual(sortedTopics);
    expect(topicEnum('read_gateway_documentation').sort()).toEqual(sortedTopics);
  });

  it('filters storage documentation by scope and excludes it from unauthorized topic discovery', () => {
    expect(getInternalDocumentation('storage', ['storage:view']).content).toContain('manage_storage_objects');
    expect(getInternalDocumentation('storage', ['databases:view']).content).toContain('do not have permission');

    const storageTopics = getInternalDocumentation('missing', ['storage:view']).content;
    const databaseTopics = getInternalDocumentation('missing', ['databases:view']).content;
    expect(storageTopics).toContain('storage');
    expect(databaseTopics).not.toContain('storage');
  });

  it('keeps storage and node docs aligned with implemented contracts', () => {
    const storage = INTERNAL_DOCS.storage;
    const nodes = INTERNAL_DOCS.nodes;
    const overview = INTERNAL_DOCS.overview;

    expect(storage).toContain('list_buckets');
    expect(storage).toContain('upload_storage_object');
    expect(storage).toContain('object-uploads');
    expect(storage).toContain('do not automatically retry it');
    expect(nodes).toContain('**storage**: Unified restricted docker-daemon profile');
    expect(nodes).toContain('**databases**: Legacy restricted docker-daemon profile');
    expect(overview).not.toContain('expected in 2.11');
    expect(overview).not.toContain('not available operations');
  });
});
