import { describe, expect, it, vi } from 'vitest';
import { AISkillService, type AIUserSkillRecord } from './ai.skills.js';

function createService(initial: AIUserSkillRecord[] = []) {
  let stored = [...initial];
  const settings = {
    getUserSkills: vi.fn(async () => stored),
    setUserSkills: vi.fn(async (skills: AIUserSkillRecord[]) => {
      stored = skills;
    }),
  };
  return { service: new AISkillService(settings as never), settings, stored: () => stored };
}

describe('AISkillService', () => {
  it('lists immutable system skills and manages shared user skills', async () => {
    const { service, settings, stored } = createService();
    expect((await service.listAllForSettings()).some((skill) => skill.id === 'system:infrastructure-operations')).toBe(
      true
    );

    const created = await service.create({
      name: 'Production naming',
      description: 'Naming conventions for production resources',
      instructions: 'Use the prod- prefix.',
    });
    expect(created).toMatchObject({ source: 'user', enabled: true });
    expect(stored()).toHaveLength(1);

    const updated = await service.update(created.id, { enabled: false, name: 'Resource naming' });
    expect(updated).toMatchObject({ name: 'Resource naming', enabled: false });
    expect(settings.setUserSkills).toHaveBeenCalledTimes(2);

    await expect(service.update('system:infrastructure-operations', { enabled: false })).rejects.toMatchObject({
      code: 'AI_SYSTEM_SKILL_IMMUTABLE',
    });
    await expect(service.delete('system:infrastructure-operations')).rejects.toMatchObject({
      code: 'AI_SYSTEM_SKILL_IMMUTABLE',
    });

    await service.delete(created.id);
    expect(stored()).toEqual([]);
  });

  it('lists system and enabled user skills but hides disabled user skills at runtime', async () => {
    const now = new Date().toISOString();
    const { service } = createService([
      {
        id: 'enabled-skill',
        name: 'Acme deployment',
        description: 'Deploy Acme services',
        instructions: 'Use the Acme release checklist.',
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'disabled-skill',
        name: 'Legacy deployment',
        description: 'Legacy process',
        instructions: 'Do not load this.',
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await expect(service.listRuntimeSkills()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'enabled-skill', source: 'user' }),
        expect.objectContaining({ id: 'system:connectors-and-repositories', source: 'system' }),
      ])
    );
    expect((await service.listRuntimeSkills()).some((skill) => skill.id === 'disabled-skill')).toBe(false);
    await expect(service.getRuntimeSkill('disabled-skill')).rejects.toMatchObject({ code: 'AI_SKILL_NOT_FOUND' });
  });

  it('keeps operational policy in immutable system skills instead of the base prompt', async () => {
    const { service } = createService();
    const systemSkills = service.listSystemSkills();
    const instructions = systemSkills.map((skill) => skill.instructions).join('\n');

    expect(instructions).toContain('Missing prerequisites are setup decisions, not terminal blockers');
    expect(instructions).toContain('Use find_resource first');
    expect(instructions).toContain('Docker container runtime IDs are volatile');
    expect(instructions).toContain('never propose a host bind path');
    expect(instructions).toContain('Choose the Secure Docker profile only when the node reports a healthy');
    expect(instructions).toContain('Never route connector setup through Finalize Setup');
    expect(instructions).toContain('External SSH connectors are only for servers outside Gateway management');
    expect(instructions).toContain('Additional permissions are an exact replacement');
    expect(instructions).toContain('OpenAI-compatible Workspace providers use the configured default reasoning effort');
    expect(instructions).toContain('Correlate timestamps and resource identities');
    expect(instructions).toContain('Do not search previous chats by default');
    expect(instructions).toContain('Gateway Inference is separate from AI Workspace');
    expect(instructions).toContain('npx -y @wiolett/gateway-inference@latest setup codex');
    expect(instructions).toContain('Claude Code 2.1.129 or newer');
    expect(instructions).toContain('generalSettings.inference.harnessSpecificEndpointsEnabled');
    expect(instructions).toContain('Deliverable files must be written under /workspace');
    expect(instructions).toContain('lead with concrete findings');
  });
});
