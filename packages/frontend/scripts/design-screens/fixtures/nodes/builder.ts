import type { Node } from "@/types";
import { nodeBySlug } from "../nodes";
import { ago, uuid } from "../time";

/** A dedicated BuildKit worker that runs the Git builds; only the Nodes screens list it. */
export const buildWorker: Node = {
  ...nodeBySlug("apps-2")!,
  id: uuid(1570),
  slug: "build-1",
  hostname: "build-1",
  displayName: "Build worker",
  type: "builder",
  appearanceColor: null,
  serviceAddresses: [],
  serviceAddress: null,
  sortOrder: 8,
  createdAt: ago(120, "d"),
};
