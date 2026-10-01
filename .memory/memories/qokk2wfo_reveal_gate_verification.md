---
{
  "id": "qokk2wfo",
  "file_name": "qokk2wfo_reveal_gate_verification",
  "tags": [
    "animation",
    "frontend",
    "reveal-gate",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.92,
  "created_at": 1790446177695,
  "updated_at": 1790812724901
}
---
Reveal gates (packages/frontend/src/components/common/PageTransition.tsx and reveal-gate.tsx): a nested gate (TabsContent) often reveals before its page gate, because its data is ready first. If a revealed gate sets `visibility: visible`, it shows through the still-hidden page (CSS visibility on a child overrides a hidden parent). The page's staggered entrance then starts every block at opacity 0, so the tab content appears, vanishes and fades in again: the "page flashes twice" bug that rc.11 did not fix. Rule: a revealed gate sets no visibility (inherits); only the unrevealed state sets `visibility: hidden`. The regression test for it (PageTransition.test.tsx, "keeps a tab that is ready before its page hidden until the page reveals") was removed from main by the 2026-09-29 light-suite cut; the rule stands.

Verification rule after three releases spent on this: never ship an animation/reveal fix verified only in jsdom. Check it in a production build of the real console on fixtures through MSW in the browser (`?latency=<ms>`, http://localhost:4174) and drive it with Chrome (playwright-core), recording per animation frame the gate phases and whether header/tab content is visible (computed visibility × effective opacity). A correct navigation shows hidden → fading → shown once, never shown → hidden → shown. The production build matters: `src/main.tsx` wraps the app in StrictMode, whose dev double effects add fake extra animations.

Where the fixture build (app preview) lives, as of 2026-10-01:
- On main: `pnpm --filter frontend app-preview` (config in `packages/frontend/scripts/app-preview/`).
- On the unmerged WIP branch `design/canvas-corrections` (from 2026-09-27) it was moved out of the repository into the local, gitignored foss-design folder `.design/canvas/gateway/tools/app-preview` (synced through foss-design Cloud); there, build and serve it from packages/frontend with `npx vite build|preview --config ../../.design/canvas/gateway/tools/app-preview/vite.config.ts`. Check which layout the current checkout has before running it.
