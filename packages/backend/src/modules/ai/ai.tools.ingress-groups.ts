import type { AIToolDefinition } from './ai.types.js';

export const INGRESS_GROUP_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_ingress_group',
    description:
      'Ingress groups: sets of nginx ingress nodes (normally one per site) that serve the same routes and domains, each member with its own config and certificate replicas. Reading needs ingress:groups:view (broadly or on the group node folder; ingress:groups:manage implies it); changes need ingress:groups:manage (broadly or on the folder) and, to put a node in a group, nodes:manage on that node. Creating a group or growing its runtime (create, update, add_member, reorder, convert_route, convert_domain) needs the multi-node availability license feature; delete and remove_member do not. Operations: list; get (members with state and ingress health, routes and domains with per-member delivery: config and certificate version each member confirmed, pending or failed with the reason); create (name, nodeIds in site-preference order, optional description and folderId); update (name, description, folderId, dnsFailoverMode: only none, where Cloudflare DNS lists every active member address as round robin without health checks); delete (only when no route or domain uses the group); add_member (nodeId, optional position: the node receives every route config, certificate and Secure Link source before its address is published in DNS; an offline node stays joining until it reconnects); remove_member (nodeId: DNS first, the member keeps serving until no public name resolves to it, at most 24 h; force removes at once, while DNS caches may still send clients to it); reorder (nodeIds: every member in the new site-preference order); convert_route (proxyHostId: serve an existing route from every member, new members first, zero downtime; needs proxy:edit on the route and proxy:create covering every member); convert_domain (domainId: move a domain and its routes onto the group, members first and DNS last; needs domains:edit on it and domains:create covering every member). Moving a route or domain back to one node: update_route or manage_domain update with ingressGroupId null and the member node. Only nginx nodes whose daemon reports the ingress_group_v1 capability can be members.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'list',
            'get',
            'create',
            'update',
            'delete',
            'add_member',
            'remove_member',
            'reorder',
            'convert_route',
            'convert_domain',
          ],
        },
        groupId: { type: 'string', description: 'Ingress group UUID (every operation except list and create).' },
        search: { type: 'string', description: 'list: filter by name or slug.' },
        name: { type: 'string', description: 'create, update: group name.' },
        description: { type: ['string', 'null'], description: 'create, update: optional description.' },
        folderId: {
          type: ['string', 'null'],
          description: 'create, update: node folder UUID of the group (null = root); list: only groups in this folder.',
        },
        dnsFailoverMode: {
          type: 'string',
          enum: ['none'],
          description: 'update: how DNS of Cloudflare-managed group domains follows member health.',
        },
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'create: member nginx node UUIDs in site-preference order; reorder: every member in the new order.',
        },
        nodeId: { type: 'string', description: 'add_member, remove_member: nginx node UUID.' },
        position: { type: 'number', description: 'add_member: 0-based position in the site order (end when omitted).' },
        force: {
          type: 'boolean',
          description: 'remove_member: remove at once instead of waiting for DNS to stop pointing at the member.',
        },
        proxyHostId: { type: 'string', description: 'convert_route: route UUID.' },
        domainId: { type: 'string', description: 'convert_domain: domain UUID.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'ingress:groups:view',
    invalidateStores: ['proxy', 'domains', 'nodes'],
  },
];
