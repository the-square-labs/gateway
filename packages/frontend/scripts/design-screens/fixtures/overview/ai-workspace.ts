/**
 * The AI Workspace sidebar: Work Sessions and their folders. The open session
 * is the grafana investigation from the AI panel fixtures. Seeds 24000-24099.
 */
import { http } from "msw";
import type { AIConversationSummary } from "@/services/ai-conversations";
import { wrapped } from "../../handlers";
import { aiConversation, earlierConversations } from "../edge/ai-panel";
import { ago, uuid } from "../time";

export const aiFolders = [
  {
    id: uuid(24001),
    name: "Incidents",
    description: "Investigations of alerts and outages",
    sortOrder: 0,
    createdAt: ago(40, "d"),
    updatedAt: ago(2, "d"),
  },
  {
    id: uuid(24002),
    name: "Releases",
    description: "Deploys and rollbacks",
    sortOrder: 1,
    createdAt: ago(40, "d"),
    updatedAt: ago(3, "d"),
  },
];

const session = (
  seed: number,
  title: string,
  daysAgo: number,
  messageCount: number,
  folderId: string | null
): AIConversationSummary => ({
  ...aiConversation,
  id: uuid(24010 + seed),
  title,
  createdAt: ago(daysAgo, "d"),
  updatedAt: ago(daysAgo, "d"),
  lastUserMessageAt: ago(daysAgo, "d"),
  messageCount,
  folderId,
  status: "ended",
});

export const aiSessions: AIConversationSummary[] = [
  aiConversation,
  ...earlierConversations.map((conversation, index) => ({
    ...conversation,
    folderId: index === 1 ? aiFolders[1].id : null,
  })),
  session(1, "Why did the 02:00 backup of orders-db run long?", 4, 11, aiFolders[0].id),
  session(2, "Move docs-portal to Edge Amsterdam", 6, 18, aiFolders[1].id),
  session(3, "Audit who can read analytics", 9, 7, null),
];

export function aiWorkspaceHandlers() {
  return [
    http.get("*/api/ai/conversations", () => wrapped(aiSessions)),
    http.get("*/api/ai/conversation-folders", () => wrapped(aiFolders)),
  ];
}
