import { configure } from "@testing-library/react";
import { vi } from "vitest";

// Runs after src/test/setup.ts. Everything here only shapes the environment the
// real app renders in; no product module is replaced except the AI store's
// socket lifecycle, which would otherwise try to open a live connection.

vi.mock("@/stores/ai.store-lifecycle", () => ({ installAIStoreLifecycle: vi.fn() }));

// A desktop viewport, so the layout picks its desktop shell.
export const VIEWPORT = { width: 1440, height: 900 };
Object.defineProperty(window, "innerWidth", {
  configurable: true,
  writable: true,
  value: VIEWPORT.width,
});
Object.defineProperty(window, "innerHeight", {
  configurable: true,
  writable: true,
  value: VIEWPORT.height,
});


// Pages wait for every request their first render needs; give them time.
configure({ asyncUtilTimeout: 15_000 });
