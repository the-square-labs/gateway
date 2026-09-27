// The frontend's own toolchain, resolved from packages/frontend: the TypeScript
// compiler (props and cva variants), Tailwind's default theme (raw palette
// colours) and the React version the specimens run.

import { createRequire } from "node:module";
import path from "node:path";

export function loadToolchain(frontendDir) {
  const frontendRequire = createRequire(path.join(frontendDir, "package.json"));
  return {
    ts: frontendRequire("typescript"),
    tailwindThemePath: frontendRequire.resolve("tailwindcss/theme.css"),
    reactVersion: frontendRequire("react/package.json").version,
  };
}
