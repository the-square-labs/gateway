export const PERMISSIONS_DOC = `# Permissions & Scopes

Gateway uses a scope-based permission system with nested group inheritance. Each user belongs to a permission group and may also have additional user-specific scopes. Effective permissions are the union of inherited group scopes and these additive user scopes. Groups can inherit from parent groups, forming a hierarchy.

## All Scopes

### PKI: Certificate Authorities
| Scope | Description |
|-------|-------------|
| pki:ca:view:root | List root CAs |
| pki:ca:view:intermediate | List intermediate CAs |
| pki:ca:view:root | View root CA details |
| pki:ca:view:intermediate | View intermediate CA details |
| pki:ca:create:root | Create root CAs |
| pki:ca:create:intermediate | Create intermediate CAs (resource-scopable) |
| pki:ca:revoke:root | Revoke root CAs |
| pki:ca:revoke:intermediate | Revoke intermediate CAs |

### PKI: Certificates
| Scope | Description |
|-------|-------------|
| pki:cert:view | List PKI certificates |
| pki:cert:view | View certificate details |
| pki:cert:issue | Issue certificates from a CA (resource-scopable) |
| pki:cert:revoke | Revoke certificates |
| pki:cert:export | Download certificate files and private keys |

### PKI: Certificate Templates
| Scope | Description |
|-------|-------------|
| pki:templates:view | List certificate templates |
| pki:templates:view | View template details |
| pki:templates:create | Create templates |
| pki:templates:edit | Edit templates |
| pki:templates:delete | Delete templates |

### Reverse Proxy
| Scope | Description |
|-------|-------------|
| proxy:view | List proxy hosts |
| proxy:view | View proxy host details (resource-scopable) |
| proxy:create | Create proxy hosts (resource-scopable) |
| proxy:edit | Update proxy hosts (resource-scopable) |
| proxy:delete | Delete proxy hosts (resource-scopable) |
| proxy:folders:manage | Manage proxy host folders and folder placement |
| proxy:raw:read | View raw nginx config in browser-only raw config workflows (resource-scopable) |
| proxy:raw:write | Write raw nginx config (resource-scopable) |
| proxy:raw:toggle | Enable/disable raw config mode (resource-scopable) |
| proxy:raw:bypass | Bypass dangerous raw nginx directive restrictions; browser/session-only (resource-scopable) |
| proxy:advanced | Edit advanced nginx snippets (resource-scopable) |
| proxy:advanced:bypass | Bypass advanced nginx snippet restrictions (resource-scopable) |

### SSL Certificates
| Scope | Description |
|-------|-------------|
| ssl:cert:view | List SSL certificates |
| ssl:cert:view | View SSL certificate details |
| ssl:cert:issue | Request ACME / upload / link internal certs |
| ssl:cert:delete | Delete SSL certificates (resource-scopable) |
| ssl:cert:revoke | Revoke SSL certificates (resource-scopable) |
| ssl:cert:export | Export SSL certificates (resource-scopable) |

### Domains
| Scope | Description |
|-------|-------------|
| domains:view | List and view managed domains |
| domains:create | Register domains |
| domains:edit | Edit/check managed domains (resource-scopable) |
| domains:delete | Delete managed domains (resource-scopable) |
| domains:folders:manage | Manage domain folders and placement |

### Access Control Lists
| Scope | Description |
|-------|-------------|
| acl:view | List access lists |
| acl:view | View access list details |
| acl:create | Create access lists |
| acl:edit | Edit access lists (resource-scopable) |
| acl:delete | Delete access lists (resource-scopable) |

### Nodes
| Scope | Description |
|-------|-------------|
| nodes:details | List daemon nodes |
| nodes:details | View node details, health, stats (resource-scopable) |
| nodes:create | Create/enroll new nodes |
| nodes:rename | Rename a node (resource-scopable) |
| nodes:delete | Delete a node (resource-scopable) |
| nodes:config:view | View node nginx config (resource-scopable) |
| nodes:config:edit | Edit node nginx config (resource-scopable) |
| nodes:logs | View daemon/nginx logs (resource-scopable) |
| nodes:console | Open interactive shell (resource-scopable) |
| nodes:files:read | Browse, open, copy, and download node files (resource-scopable) |
| nodes:files:write | Create, edit, upload, move, and delete node files (resource-scopable) |
| nodes:folders:manage | Manage node folders and folder placement |

### Administration
| Scope | Description |
|-------|-------------|
| admin:users | Manage users and permission groups |
| admin:groups | Manage permission groups |
| admin:users:folders:manage | Manage administration user folders and placement |
| admin:groups:folders:manage | Manage permission group folders and placement |
| admin:audit | View audit log |
| admin:system | System-level administration (protected) |
| admin:update | Apply system updates |
| admin:alerts | View and manage alerts |

### Gateway Settings
| Scope | Description |
|-------|-------------|
| settings:gateway:view | View sign-in provisioning and MCP server settings |
| settings:gateway:edit | Edit sign-in provisioning and MCP server settings |

### Housekeeping
| Scope | Description |
|-------|-------------|
| housekeeping:view | View housekeeping config, stats, and history |
| housekeeping:run | Run housekeeping manually |
| housekeeping:configure | Edit housekeeping config and schedule |

### Licensing
| Scope | Description |
|-------|-------------|
| license:view | View license state |
| license:manage | Activate, update, or remove the license |

### Features
| Scope | Description |
|-------|-------------|
| feat:ai:use | Access the AI assistant |
| feat:ai:configure | Configure AI assistant settings |
| ai:sandbox:use | Use AI sandbox runner tools |
| ai:sandbox:tier:medium | Allow medium sandbox resource tier |
| ai:sandbox:tier:high | Allow high sandbox resource tier |
| ai:sandbox:manage | View/manage sandbox jobs beyond the current user |
| mcp:use | Allow a user account to access the remote MCP server with OAuth |

### Inference Gateway
| Scope | Description |
|-------|-------------|
| inference:use | Send requests through the standalone inference data plane and view the current user's inference usage |
| inference:setup | Authorize the Gateway companion CLI setup resource |
| inference:tokens:manage | Create and revoke dedicated gwi_ inference tokens for the current user |
| inference:usage:view:self | View the current user's inference usage percentages (implicitly granted by inference:use) |
| inference:providers:view | View provider templates, connections, masked credentials, discovery, and quota |
| inference:providers:manage | Connect, update, synchronize, route, and disconnect inference providers |
| inference:models:manage | Atomically create, replace, publish, or delete logical inference models |
| inference:limits:manage | Configure default and per-user inference budgets |
| inference:usage:view | View system/user inference activity and raw accounting metadata |

### Docker: Containers
| Scope | Description |
|-------|-------------|
| docker:containers:view | List containers on a node |
| docker:containers:view | View container details (resource-scopable) |
| docker:containers:create | Create/deploy containers |
| docker:containers:edit | Edit container settings (resource-scopable) |
| docker:containers:config | View container recreate/configuration fields (resource-scopable) |
| docker:containers:manage | Start/stop/restart/kill/update containers (resource-scopable) |
| docker:containers:environment | View/edit container environment variables (resource-scopable) |
| docker:containers:delete | Remove containers (resource-scopable) |
| docker:containers:console | Open exec terminal (resource-scopable) |
| docker:containers:files | Browse/edit container files (resource-scopable) |
| docker:containers:secrets | Manage encrypted secrets (resource-scopable) |
| docker:containers:webhooks | Configure CI/CD webhook URLs |
| docker:containers:mounts | Add, remove, or change container/deployment mounts (resource-scopable) |
| docker:containers:folders:manage | Manage Docker resource folders and placement |

### Docker: Images
| Scope | Description |
|-------|-------------|
| docker:images:view | List images on a node |
| docker:images:pull | Pull images from registries |
| docker:images:delete | Remove/prune images |

### Docker: Volumes
| Scope | Description |
|-------|-------------|
| docker:volumes:view | List volumes |
| docker:volumes:create | Create volumes |
| docker:volumes:delete | Remove volumes |
| docker:volumes:files:read | Browse/read volume files |
| docker:volumes:files:write | Create/edit/upload/move/delete volume files |

### Docker: Networks
| Scope | Description |
|-------|-------------|
| docker:networks:view | List networks |
| docker:networks:create | Create networks |
| docker:networks:edit | Connect/disconnect containers |
| docker:networks:delete | Remove networks |

### Docker: Registries
| Scope | Description |
|-------|-------------|
| docker:registries:view | List private registries |
| docker:registries:create | Add registries |
| docker:registries:edit | Edit/test registries |
| docker:registries:delete | Remove registries |

### Docker: Tasks
| Scope | Description |
|-------|-------------|
| docker:tasks | View background tasks |
| docker:tasks:manage | Force-cancel active background tasks |

### Databases
| Scope | Description |
|-------|-------------|
| databases:view | List saved database connections |
| databases:view | View database connection details (resource-scopable) |
| databases:create | Create saved database connections |
| databases:edit | Edit saved database connections (resource-scopable) |
| databases:delete | Delete saved database connections (resource-scopable) |
| databases:query:read | Run read-only queries; AI/MCP database tools also require databases:view for the same database |
| databases:query:write | Run write queries; AI/MCP database tools also require databases:view for the same database |
| databases:query:admin | Run admin queries; AI/MCP database tools also require databases:view for the same database |
| databases:credentials:reveal | Reveal saved database credentials (resource-scopable) |
| databases:folders:manage | Manage database folders and placement |

### Logging
| Scope | Description |
|-------|-------------|
| logs:environments:view | List logging environments |
| logs:environments:view | View logging environments (resource-scopable) |
| logs:environments:create | Create logging environments |
| logs:environments:edit | Edit logging environments (resource-scopable) |
| logs:environments:delete | Delete logging environments (resource-scopable) |
| logs:environments:folders:manage | Manage logging environment folders and placement |
| logs:tokens:view | List ingest tokens (resource-scopable by environment) |
| logs:tokens:create | Create ingest tokens (resource-scopable by environment) |
| logs:tokens:delete | Delete ingest tokens (resource-scopable by environment) |
| logs:schemas:view | List logging schemas |
| logs:schemas:view | View logging schemas (resource-scopable by schema ID) |
| logs:schemas:create | Create logging schemas |
| logs:schemas:edit | Edit logging schemas (resource-scopable by schema ID) |
| logs:schemas:delete | Delete logging schemas (resource-scopable by schema ID) |
| logs:schemas:folders:manage | Manage logging schema folders and placement |
| logs:read | Search and inspect logs (resource-scopable by environment) |
| logs:manage | Logging-wide override |

### Status Page
| Scope | Description |
|-------|-------------|
| status-page:view | View status page config, services, incidents, and preview |
| status-page:manage | Edit status page settings and exposed services |
| status-page:incidents:create | Create or promote incidents |
| status-page:incidents:update | Edit incidents and post updates |
| status-page:incidents:resolve | Resolve active incidents |
| status-page:incidents:delete | Delete incidents |

## Built-in Groups

| Group | Description |
|-------|-------------|
| system-admin | Full access including admin:system |
| admin | Curated broad access, excluding admin:system, settings:gateway:edit, housekeeping:configure, and Docker registry create/edit/delete defaults |
| operator | Operational access — PKI, proxy, SSL, ACL, nodes, Docker containers, AI |
| viewer | Read-only — view/discovery scopes for PKI, proxy, SSL, Docker containers |

Custom groups can be created with any combination of scopes.

## Nested Groups & Inheritance
Groups can have a parent group. Inherited scopes from all ancestors are added to the effective scopes. Cycle detection prevents circular inheritance. Built-in groups cannot be modified.

## Resource-Scoped Permissions
Scopes marked "resource-scopable" support resource-level suffixes (e.g., "pki:cert:issue:ca-uuid" or "nodes:details:node-uuid"). Docker container scopes use "docker:containers:<action>:<node-id>" for a whole node or "docker:containers:<action>:<node-id>/<stable-resource-id>" for one container or deployment. Without a suffix, the scope applies to all resources.

## Scope Containment Rule
A user can only manage another user whose scopes are a subset of their own.`;
