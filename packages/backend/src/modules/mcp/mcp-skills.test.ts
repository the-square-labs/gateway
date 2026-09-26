import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadGatewaySkills, registerMcpSkills } from './mcp-skills.js';

const repoSkills = fileURLToPath(new URL('../../../../../skills', import.meta.url));

describe('Gateway agent skills', () => {
  it('ships valid skills from the repository', () => {
    const skills = loadGatewaySkills(repoSkills);
    expect(skills.map((skill) => skill.name)).toContain('using-gateway');
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.files[0].path).toBe('SKILL.md');
    }
  });

  it('serves every skill file as a resource and each skill as a prompt', async () => {
    const skills = loadGatewaySkills(repoSkills);
    const server = { registerResource: vi.fn(), registerPrompt: vi.fn() };
    registerMcpSkills(server as never, skills);

    const uris = server.registerResource.mock.calls.map((call) => call[1]);
    expect(uris).toContain('gateway://skills');
    expect(uris).toContain('gateway://skills/using-gateway/SKILL.md');
    expect(uris).toContain('gateway://skills/using-gateway/references/mcp-toolsets.md');
    expect(server.registerPrompt.mock.calls.map((call) => call[0])).toContain('skill-using-gateway');

    const promptHandler = server.registerPrompt.mock.calls.find((call) => call[0] === 'skill-using-gateway')?.[2];
    const text = promptHandler().messages[0].content.text as string;
    expect(text.startsWith('---')).toBe(false);
    expect(text).toContain('gateway://skills/using-gateway/references/mcp-toolsets.md');
  });

  it('skips a folder whose SKILL.md name does not match it', () => {
    expect(loadGatewaySkills(fileURLToPath(new URL('./__missing__', import.meta.url)))).toEqual([]);
  });
});
