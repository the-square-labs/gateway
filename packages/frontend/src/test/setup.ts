import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./msw/server";
import { resetTestStores } from "./reset-stores";

Object.defineProperty(globalThis, "Event", {
  configurable: true,
  writable: true,
  value: window.Event,
});

Object.defineProperty(globalThis, "CustomEvent", {
  configurable: true,
  writable: true,
  value: window.CustomEvent,
});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockBroadcastChannel {
  constructor(readonly name: string) {}
  close() {}
  postMessage(_message: unknown) {}
  addEventListener() {}
  removeEventListener() {}
}

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = MockEventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string | URL) {}
  addEventListener() {}
  close() {}
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: MockResizeObserver,
});

Object.defineProperty(window, "BroadcastChannel", {
  configurable: true,
  writable: true,
  value: MockBroadcastChannel,
});

Object.defineProperty(window, "EventSource", {
  configurable: true,
  writable: true,
  value: MockEventSource,
});

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  writable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  },
});

Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  writable: true,
  value: vi.fn(() => "blob:mock"),
});

Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window, "open", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetTestStores();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  server.close();
});
