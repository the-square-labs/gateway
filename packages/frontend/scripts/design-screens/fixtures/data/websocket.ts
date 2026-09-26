/**
 * jsdom's WebSocket would dial the fixture origin and fail, so log tabs would
 * stay on "Connecting…". Screens whose content arrives over a socket (managed
 * database logs) install this one instead: it opens, then sends the fixture
 * frames for the socket URL the way the server's first messages would.
 */
type FrameResolver = (url: string) => unknown[] | undefined;

export function installFixtureWebSocket(resolve: FrameResolver) {
  class FixtureWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    readonly url: string;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const frames = resolve(this.url) ?? [];
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        const open = new Event("open");
        this.onopen?.(open);
        this.dispatchEvent(open);
        for (const frame of frames) {
          if (this.readyState !== 1) return;
          const message = new MessageEvent("message", { data: JSON.stringify(frame) });
          this.onmessage?.(message);
          this.dispatchEvent(message);
        }
      }, 0);
    }

    send() {}

    close() {
      this.readyState = 3;
    }
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    writable: true,
    value: FixtureWebSocket,
  });
}
