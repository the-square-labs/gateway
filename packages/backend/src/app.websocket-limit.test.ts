import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app.js';
import { container } from '@/container.js';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsService,
} from '@/modules/settings/environment-settings.service.js';
import { EventBusService } from '@/services/event-bus.service.js';

afterEach(() => {
  container.reset();
});

describe('WebSocket transport payload limits', () => {
  it('applies runtime decreases before new frames and terminates existing inference sockets', () => {
    const settings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
    settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 8 * 1024 * 1024;
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => structuredClone(settings),
    } as EnvironmentSettingsService);

    const { wss } = createApp();
    const inferenceSocket = {
      once: vi.fn(),
      terminate: vi.fn(),
    };
    const unrelatedSocket = {
      once: vi.fn(),
      terminate: vi.fn(),
    };
    wss.emit('connection', inferenceSocket as never, { url: '/api/inference/v1/responses' } as never);
    wss.emit('connection', unrelatedSocket as never, { url: '/api/events' } as never);

    settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 2 * 1024 * 1024;
    eventBus.publish('system.config.changed', { key: 'environment:settings' });

    expect(wss.options.maxPayload).toBe(2 * 1024 * 1024);
    expect(inferenceSocket.terminate).toHaveBeenCalledOnce();
    expect(unrelatedSocket.terminate).not.toHaveBeenCalled();
  });

  it('applies runtime increases to new connections without interrupting active inference sockets', () => {
    const settings = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS);
    settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 2 * 1024 * 1024;
    const eventBus = new EventBusService();
    container.registerInstance(EventBusService, eventBus);
    container.registerInstance(EnvironmentSettingsService, {
      getSnapshot: () => structuredClone(settings),
    } as EnvironmentSettingsService);

    const { wss } = createApp();
    const inferenceSocket = {
      once: vi.fn(),
      terminate: vi.fn(),
    };
    wss.emit('connection', inferenceSocket as never, { url: '/api/inference/v1/responses' } as never);

    settings.requestLimits.inferenceWebSocketMaxPayloadBytes = 8 * 1024 * 1024;
    eventBus.publish('system.config.changed', { key: 'environment:settings' });

    expect(wss.options.maxPayload).toBe(8 * 1024 * 1024);
    expect(inferenceSocket.terminate).not.toHaveBeenCalled();
  });
});
