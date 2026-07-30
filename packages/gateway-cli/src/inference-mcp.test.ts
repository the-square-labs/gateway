import { consumeSse, eventStreamHeaders } from './inference-mcp.js';

describe('inference MCP event stream', () => {
  it('parses chunked LF and CRLF SSE frames without treating heartbeats as invalidations', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {"catalogVersion":"v1"}\n'));
        controller.enqueue(encoder.encode('\nevent: heartbeat\r\n\r\nid: event-42\r\nevent: invalidate\r\n'));
        controller.enqueue(encoder.encode('data: {"type":"catalog.changed"}\r\n\r\n'));
        controller.close();
      },
    });
    const events: Array<{ event: string; data: string; id?: string }> = [];

    await consumeSse(stream, (event, data, id) => {
      events.push({ event, data, ...(id ? { id } : {}) });
    });

    expect(events).toEqual([
      { event: 'ready', data: '{"catalogVersion":"v1"}' },
      { event: 'heartbeat', data: '' },
      { event: 'invalidate', data: '{"type":"catalog.changed"}', id: 'event-42' },
    ]);
  });

  it('sends the last accepted event ID when reconnecting', () => {
    const initial = eventStreamHeaders('gwo_test');
    const replay = eventStreamHeaders('gwo_test', 'event-42');

    expect(initial.get('Last-Event-ID')).toBeNull();
    expect(replay.get('Last-Event-ID')).toBe('event-42');
    expect(replay.get('Authorization')).toBe('Bearer gwo_test');
  });
});
