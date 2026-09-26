// Starts the fixture backend (MSW in the browser), then the real console entry.
import { setupWorker } from "msw/browser";
import { previewHandlers } from "./handlers";

async function start() {
  await setupWorker(...previewHandlers()).start({
    serviceWorker: { url: "/mockServiceWorker.js" },
    onUnhandledRequest: "bypass",
    quiet: true,
  });
  await import("../../src/main");
}

void start();
