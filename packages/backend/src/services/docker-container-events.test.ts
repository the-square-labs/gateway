import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DockerService } from './docker.service.js';

let socketDir = '';
let server: http.Server | null = null;

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
});

describe('DockerService.listContainerEvents', () => {
  it('reads a bounded window of one container lifecycle events from the Docker event history', async () => {
    socketDir = mkdtempSync(join(tmpdir(), 'docker-events-'));
    const socketPath = join(socketDir, 'docker.sock');
    let requested = '';
    server = http.createServer((req, res) => {
      requested = req.url ?? '';
      res.statusCode = 200;
      // Docker streams one JSON object per line and closes the stream at `until`. Nanosecond times
      // are wider than a double, as on the wire.
      res.end(
        [
          '{"Type":"container","Action":"kill","Actor":{"ID":"relay-id","Attributes":{"signal":"15"}},"time":1790580229,"timeNano":1790580229080123456}',
          '{"Type":"container","Action":"start","Actor":{"ID":"relay-id","Attributes":{}},"time":1790580235,"timeNano":1790580235051000000}',
          '{"Type":"container","status":"die","id":"relay-id","time":1790580234}',
          '',
        ].join('\n')
      );
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));

    const events = await new DockerService(socketPath, '').listContainerEvents(
      'relay-id',
      1790580220_000,
      1790580240_500
    );

    const url = new URL(requested, 'http://docker');
    expect(url.pathname).toBe('/v1.46/events');
    expect(url.searchParams.get('since')).toBe('1790580220.000');
    expect(url.searchParams.get('until')).toBe('1790580240.500');
    expect(JSON.parse(url.searchParams.get('filters') ?? '{}')).toEqual({
      type: ['container'],
      container: ['relay-id'],
      event: ['kill', 'die', 'stop', 'start', 'restart'],
    });
    expect(events.map((event) => [event.action, event.timeMs])).toEqual([
      ['kill', 1790580229080],
      ['die', 1790580234000],
      ['start', 1790580235051],
    ]);
    expect(events[0]?.attributes).toEqual({ signal: '15' });
  });
});
