/**
 * The test setup replaces EventSource with a silent stub. Screens whose data
 * arrives over a server-sent stream (database monitoring) install this one
 * instead: it answers `addEventListener(name)` with the fixture events for the
 * stream URL, the way the server's first frames would.
 */
type StreamEvents = Record<string, unknown>;
type StreamResolver = (url: string) => StreamEvents | undefined;

export function installFixtureEventSource(resolve: StreamResolver) {
  class FixtureEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readyState = 1;
    withCredentials = true;
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    readonly url: string;
    private readonly events: StreamEvents;
    private closed = false;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      this.events = resolve(this.url) ?? {};
    }

    override addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      super.addEventListener(type, listener, options);
      if (!(type in this.events)) return;
      const data = JSON.stringify(this.events[type]);
      setTimeout(() => {
        if (this.closed) return;
        this.dispatchEvent(new MessageEvent(type, { data }));
      }, 0);
    }

    close() {
      this.closed = true;
      this.readyState = 2;
    }
  }

  Object.defineProperty(window, "EventSource", {
    configurable: true,
    writable: true,
    value: FixtureEventSource,
  });
}
