/**
 * Nginx config templates: the list (the route fixtures' templates plus a few
 * more custom ones), the folders the operator keeps them in and single-template
 * reads. Seeds 22500-22549 belong to this file.
 */
import { HttpResponse, http } from "msw";
import { useAuthStore } from "@/stores/auth";
import type { NginxTemplate, ResourceFolderTreeNode } from "@/types";
import { wrapped } from "../../handlers";
import { expandFolders } from "../data/folders";
import { nginxTemplates } from "../routes/data";
import { ago, uuid } from "../time";

function folder(seed: number, name: string, sortOrder: number): ResourceFolderTreeNode {
  return {
    id: uuid(22500 + seed),
    name,
    parentId: null,
    sortOrder,
    depth: 0,
    createdAt: ago(90, "d"),
    updatedAt: ago(90, "d"),
    children: [],
  };
}

export const nginxTemplateFolders: ResourceFolderTreeNode[] = [
  folder(1, "Security", 0),
  folder(2, "Streaming", 1),
];
const [securityFolder, streamingFolder] = nginxTemplateFolders;

export const hardenedProxyTemplate = nginxTemplates.find(
  (template) => template.name === "Hardened proxy (HSTS + CSP)"
)!;
const longPollTemplate = nginxTemplates.find((template) => template.name === "Long-poll API")!;
const defaultProxyTemplate = nginxTemplates.find((template) => template.name === "Default Proxy")!;

function customTemplate(
  seed: number,
  overrides: Partial<NginxTemplate> & Pick<NginxTemplate, "name" | "content">
): NginxTemplate {
  return {
    id: uuid(22510 + seed),
    description: null,
    isBuiltin: false,
    type: "proxy",
    variables: defaultProxyTemplate.variables,
    folderId: null,
    sortOrder: 0,
    createdAt: ago(40, "d"),
    updatedAt: ago(40, "d"),
    ...overrides,
  };
}

/** Every template the list shows, placed in folders. Built-in ones never are. */
export const nginxTemplateList: NginxTemplate[] = [
  ...nginxTemplates.map((template) => ({
    ...template,
    folderId:
      template.id === hardenedProxyTemplate.id
        ? securityFolder.id
        : template.id === longPollTemplate.id
          ? streamingFolder.id
          : null,
    sortOrder: 0,
  })),
  customTemplate(1, {
    name: "Geo-restricted proxy",
    description: "Default proxy that only answers clients from the allowed country list.",
    content: "server {\n  if ($allowed_country = no) { return 403; }\n}",
    folderId: securityFolder.id,
    sortOrder: 1,
    updatedAt: ago(9, "d"),
  }),
  customTemplate(2, {
    name: "WebSocket upstream",
    description: "Upgrade headers and a one-hour idle timeout for socket services.",
    content:
      'server {\n  proxy_set_header Upgrade $http_upgrade;\n  proxy_set_header Connection "upgrade";\n  proxy_read_timeout 3600s;\n}',
    folderId: streamingFolder.id,
    sortOrder: 1,
  }),
  customTemplate(3, {
    name: "Static site (long cache)",
    description: "Immutable caching for fingerprinted assets, short cache for HTML.",
    content:
      'server {\n  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }\n}',
    createdAt: ago(20, "d"),
    updatedAt: ago(3, "d"),
  }),
  customTemplate(4, {
    name: "Maintenance redirect",
    description: "Sends every request to the status page while a service is down.",
    type: "redirect",
    variables: [],
    content: "server {\n  return 302 https://status.example.com;\n}",
    sortOrder: 1,
  }),
];

/**
 * The template list as the operator left it: every folder open. The folder
 * scope is not in the token scope catalog yet (backend work), so the fixture
 * operator gets it here to see folder management and drag and drop.
 */
export function prepareNginxTemplateList() {
  useAuthStore.setState((state) => ({
    user: state.user && {
      ...state.user,
      scopes: [...state.user.scopes, "proxy:templates:folders:manage"],
    },
  }));
  expandFolders("nginx-template", [
    "nginx-templates-builtin",
    ...nginxTemplateFolders.map((item) => item.id),
  ]);
}

export function nginxTemplateHandlers() {
  return [
    http.get("*/api/nginx-templates", () => wrapped(nginxTemplateList)),
    // Before `/nginx-templates/:id`, which would take "folders" for an id.
    http.get("*/api/nginx-templates/folders", () => wrapped(nginxTemplateFolders)),
    http.get("*/api/nginx-templates/:id", ({ params }) => {
      const template = nginxTemplateList.find((item) => item.id === params.id);
      return template
        ? wrapped(template)
        : HttpResponse.json({ message: "Not found" }, { status: 404 });
    }),
  ];
}
