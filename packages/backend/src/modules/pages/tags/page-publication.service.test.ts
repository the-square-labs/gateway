import { describe, expect, it, vi } from 'vitest';
import { PagePublicationService } from './page-publication.service.js';

const request = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  tagId: '33333333-3333-4333-8333-333333333333',
  tag: 'production',
  deploymentId: '44444444-4444-4444-8444-444444444444',
  publicSlug: 'abcdef',
  sequence: 2,
  expectedGeneration: 3,
  requestedById: 'user-1',
};

describe('PagePublicationService consumer rollback', () => {
  it('materializes immutable consumers before marking a Deployment ready', async () => {
    const staged = {
      id: request.deploymentId,
      projectId: request.projectId,
      publicSlug: request.publicSlug,
      sequence: request.sequence,
      status: 'staging',
      createdById: 'user-1',
      requestedTag: null,
    };
    const ready = { ...staged, status: 'ready' };
    const statusSets: Array<Record<string, unknown>> = [];
    let updateCall = 0;
    const db = {
      update: vi.fn(() => {
        const call = updateCall++;
        return {
          set: vi.fn((values) => {
            statusSets.push(values);
            return { where: vi.fn(() => ({ returning: vi.fn(async () => [call === 0 ? staged : ready]) })) };
          }),
        };
      }),
    };
    const tagService = { beginActivation: vi.fn().mockResolvedValue(null) };
    const audit = { log: vi.fn() };
    const publish = vi.fn();
    const service = new PagePublicationService(db as never, audit as never, tagService as never);
    service.setDeploymentAdapter({ publish });

    await service.markDeploymentReady(request.deploymentId);

    expect(statusSets.map((values) => values.status)).toEqual(['staging', 'ready']);
    expect(publish).toHaveBeenCalledWith(request.deploymentId);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[1]!);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'page_deployment.ready' }));
  });

  it('leaves a failed consumer publication retryable in staging', async () => {
    const staged = {
      id: request.deploymentId,
      projectId: request.projectId,
      publicSlug: request.publicSlug,
      sequence: request.sequence,
      status: 'staging',
      createdById: 'user-1',
      requestedTag: null,
    };
    const update = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [staged]) })) })),
    }));
    const service = new PagePublicationService(
      { update } as never,
      { log: vi.fn() } as never,
      { beginActivation: vi.fn() } as never
    );
    service.setDeploymentAdapter({ publish: vi.fn().mockRejectedValue(new Error('target offline')) });

    await expect(service.markDeploymentReady(request.deploymentId)).rejects.toThrow('target offline');
    expect(update).toHaveBeenCalledOnce();
  });

  it('rolls staged Route consumers back when the Tag generation was superseded', async () => {
    const tagService = {
      beginActivation: vi.fn().mockResolvedValue(request),
      markStaging: vi.fn(),
      markRollingBack: vi.fn(),
      completeActivation: vi.fn().mockResolvedValue(false),
      failActivation: vi.fn(),
    };
    const adapter = {
      stage: vi.fn().mockResolvedValue({ routes: [{ routeId: 'route-1' }] }),
      rollback: vi.fn(),
    };
    const service = new PagePublicationService({} as never, { log: vi.fn() } as never, tagService as never);
    service.setAdapter(adapter);

    await expect(service.moveUserTag(request.projectId, request.tag, request.deploymentId, 'user-1')).resolves.toEqual(
      expect.objectContaining({ changed: false })
    );
    expect(adapter.rollback).toHaveBeenCalledWith(request, { routes: [{ routeId: 'route-1' }] });
    expect(tagService.failActivation).not.toHaveBeenCalled();
  });

  it('rolls Route consumers back when the final Tag activation CAS fails', async () => {
    const oldDeploymentId = '55555555-5555-4555-8555-555555555555';
    const newDeploymentId = request.deploymentId;
    const route = { deploymentId: oldDeploymentId, status: 'ready' };
    const progress = {
      routes: [
        {
          routeId: 'route-1',
          fromDeploymentId: oldDeploymentId,
          toDeploymentId: newDeploymentId,
          generation: 4,
        },
      ],
    };
    const tag = { deploymentId: oldDeploymentId, generation: request.expectedGeneration };
    const tagService = {
      beginActivation: vi.fn().mockResolvedValue(request),
      markStaging: vi.fn(),
      markRollingBack: vi.fn(),
      completeActivation: vi.fn().mockRejectedValue(new Error('final activation CAS was empty')),
      failActivation: vi.fn(),
    };
    const adapter = {
      stage: vi.fn().mockImplementation(async () => {
        route.deploymentId = newDeploymentId;
        return progress;
      }),
      rollback: vi.fn().mockImplementation(async (_request, appliedProgress) => {
        expect(appliedProgress).toEqual(progress);
        route.deploymentId = oldDeploymentId;
      }),
    };
    const service = new PagePublicationService({} as never, { log: vi.fn() } as never, tagService as never);
    service.setAdapter(adapter);

    await expect(
      service.moveUserTag(request.projectId, request.tag, request.deploymentId, 'user-1')
    ).rejects.toMatchObject({ code: 'PAGE_TAG_PUBLICATION_FAILED' });
    expect(tag).toEqual({ deploymentId: oldDeploymentId, generation: request.expectedGeneration });
    expect(route).toEqual({ deploymentId: oldDeploymentId, status: 'ready' });
    expect(tagService.markRollingBack).toHaveBeenCalledWith(request.id, progress);
    expect(tagService.failActivation).toHaveBeenCalledWith(request, 'PAGE_TAG_PUBLICATION_FAILED');
  });

  it('persists an explicit failure when a consumer rollback fails', async () => {
    const tagService = {
      beginActivation: vi.fn().mockResolvedValue(request),
      markStaging: vi.fn(),
      markRollingBack: vi.fn(),
      completeActivation: vi.fn().mockRejectedValue(new Error('tag switch failed')),
      failActivation: vi.fn(),
    };
    const adapter = {
      stage: vi.fn().mockResolvedValue({ routes: [{ routeId: 'route-1' }] }),
      rollback: vi.fn().mockRejectedValue(new Error('node unavailable')),
    };
    const service = new PagePublicationService({} as never, { log: vi.fn() } as never, tagService as never);
    service.setAdapter(adapter);

    await expect(
      service.moveUserTag(request.projectId, request.tag, request.deploymentId, 'user-1')
    ).rejects.toMatchObject({ code: 'PAGE_TAG_ROLLBACK_FAILED' });
    expect(tagService.markRollingBack).toHaveBeenCalledWith(request.id, {
      routes: [{ routeId: 'route-1' }],
    });
    expect(tagService.failActivation).toHaveBeenCalledWith(request, 'PAGE_TAG_ROLLBACK_FAILED');
  });
});
