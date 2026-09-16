import { pgEnum } from 'drizzle-orm/pg-core';

// Shared by hosts and templates without a runtime table-import cycle.
export const proxyHostTypeEnum = pgEnum('proxy_host_type', ['proxy', 'redirect', '404', 'raw']);
