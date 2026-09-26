import fs from "node:fs";
import path from "node:path";
import { act, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http, type HttpHandler } from "msw";
import { vi } from "vitest";
import App from "@/App";
import { eventStream } from "@/services/event-stream";
import { registerAuthContextReset, useAuthStore } from "@/stores/auth";
import { usePinnedDatabasesStore } from "@/stores/pinned-databases";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { resetClientSessionState } from "@/stores/session-reset";
import { useUIStore } from "@/stores/ui";
import { server } from "@/test/msw/server";
import { waitForReveal } from "@/test/reveal";
import { databases } from "./fixtures/catalog";
import { adminUser } from "./fixtures/identity";
import { edgeNode } from "./fixtures/nodes";
import { shellHandlers } from "./handlers";
import { defaultHealthBarsWidth, installLayoutShims } from "./layout-shims";
import { serializeDocument } from "./serialize";
import { VIEWPORT } from "./setup";

export const OUT_DIR = path.resolve(__dirname, "out/dom");

export type UserEventApi = ReturnType<typeof userEvent.setup>;

export interface ScreenSpec {
  /** Artboard file stem, e.g. `routes-list`. */
  id: string;
  /** Name shown on the artboard's strip. */
  title: string;
  /** Canvas group the artboard belongs to. */
  group: "Screens" | "States";
  /** Location the app opens at. */
  route: string;
  /** Screen-specific API handlers, checked before the shared ones. */
  handlers?: HttpHandler[];
  /** Artboard height; width is always the desktop viewport. */
  height?: number;
  /** Seed stores before the app mounts. */
  before?: () => void | Promise<void>;
  /** Wait for data the reveal gate does not cover. */
  ready?: () => Promise<void>;
  /** Interactions after the page settled (open a dialog, press a button). */
  interact?: (user: UserEventApi) => Promise<void>;
  /** Skip waiting for the reveal (page loader state). */
  captureBeforeReveal?: () => Promise<void>;
  /** Width HealthBars measure (jsdom has no layout); defaults to the page content width. */
  healthBarsWidth?: number;
  /** Placeholder labels for boxes jsdom cannot paint (charts, editors, terminals). */
  placeholders?: Array<{ selector: string; label: string }>;
  /** Notes recorded in the manifest (what is placeholder, what is special). */
  notes?: string[];
}

interface RequestLogEntry {
  method: string;
  path: string;
  status: number | "unmocked";
}

const trace = (message: string) => {
  if (process.env.DESIGN_SCREENS_TRACE) process.stderr.write(`[design-screens] ${message}\n`);
};

const settle = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/**
 * Mounts the real app at `spec.route` against fixture handlers, waits for the
 * page to settle and writes its serialized DOM plus a manifest entry.
 */
export async function exportScreen(spec: ScreenSpec) {
  const requests: RequestLogEntry[] = [];
  const onRequest = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname + url.search, status: "unmocked" });
  };
  const onMatched = ({ request, response }: { request: Request; response: Response }) => {
    const url = new URL(request.url);
    const entry = [...requests]
      .reverse()
      .find((item) => item.path === url.pathname + url.search && item.status === "unmocked");
    if (entry) entry.status = response.status;
  };
  server.events.on("request:start", onRequest);
  server.events.on("response:mocked", onMatched);

  vi.spyOn(eventStream, "start").mockImplementation(() => {});
  vi.spyOn(eventStream, "stop").mockImplementation(() => {});
  vi.spyOn(eventStream, "subscribe").mockImplementation(() => () => {});
  vi.spyOn(eventStream, "onReconnect").mockImplementation(() => () => {});

  const onAny = ({ request }: { request: Request }) => trace(`${request.method} ${request.url}`);
  server.events.on("request:start", onAny);
  server.use(
    ...(spec.handlers ?? []),
    ...shellHandlers(),
    // Anything not covered answers 404 and is listed in the manifest.
    http.all("*", ({ request }) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/auth")) return;
      return HttpResponse.json({ message: "Not in design fixtures" }, { status: 404 });
    })
  );

  registerAuthContextReset(resetClientSessionState);
  window.history.replaceState(null, "", spec.route);
  useUIStore.setState({
    theme: "light",
    resolvedTheme: "light",
    sidebarOpen: true,
    sidebarCollapsed: false,
    showUpdateNotifications: true,
  });
  useAuthStore.setState({ user: adminUser, isAuthenticated: true, isLoading: false });
  // The operator keeps one node and one database pinned in the sidebar.
  usePinnedNodesStore.setState({ sidebarNodeIds: [edgeNode.id] });
  usePinnedDatabasesStore.setState({
    sidebarDatabaseIds: [databases[0].id],
    databaseMeta: {
      [databases[0].id]: {
        slug: databases[0].slug,
        name: databases[0].name,
        type: databases[0].type,
        healthStatus: "online",
      },
    },
  });
  installLayoutShims({
    healthBarsWidth: spec.healthBarsWidth ?? defaultHealthBarsWidth(false),
  });
  await spec.before?.();
  if (spec.healthBarsWidth === undefined && useUIStore.getState().aiPanelOpen) {
    installLayoutShims({ healthBarsWidth: defaultHealthBarsWidth(true) });
  }

  const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
  trace(`${spec.id}: render`);
  const result = render(<App />);

  let phase: "settled" | "loader" = "settled";
  if (spec.captureBeforeReveal) {
    await spec.captureBeforeReveal();
    phase = "loader";
  } else {
    await waitFor(
      () => {
        if (!document.querySelector("[data-reveal-phase]")) throw new Error("page not mounted");
      },
      { timeout: 20_000 }
    );
    trace(`${spec.id}: page mounted`);
    await waitForReveal();
    trace(`${spec.id}: revealed`);
    await spec.ready?.();
    // Let follow-up requests, reveal timers and motion settle.
    await settle(400);
    await waitForReveal();
    if (spec.interact) {
      await spec.interact(user);
      await settle(400);
      await waitForReveal();
    }
  }

  trace(`${spec.id}: serialize`);
  const serialized = serializeDocument(document, {
    keepGateHidden: phase === "loader",
    placeholders: spec.placeholders ?? [],
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const unmocked = requests.filter((entry) => entry.status !== 200 && entry.status !== 204);
  fs.writeFileSync(
    path.join(OUT_DIR, `${spec.id}.json`),
    `${JSON.stringify(
      {
        id: spec.id,
        title: spec.title,
        group: spec.group,
        route: spec.route,
        width: VIEWPORT.width,
        height: spec.height ?? VIEWPORT.height,
        notes: spec.notes ?? [],
        placeholders: (spec.placeholders ?? []).map((item) => item.label),
        unmocked,
        requests,
        ...serialized,
      },
      null,
      2
    )}\n`
  );

  server.events.removeAllListeners();
  result.unmount();
  registerAuthContextReset(() => {});
}
