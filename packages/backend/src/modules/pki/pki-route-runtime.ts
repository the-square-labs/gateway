import { caRouteRuntime } from './ca-route-runtime.js';
import { certRouteRuntime } from './cert-route-runtime.js';
import { publicPkiRouteRuntime } from './public-route-runtime.js';
import { templateRouteRuntime } from './templates-route-runtime.js';
export const pkiRouteRuntime = { caRouteRuntime, certRouteRuntime, templateRouteRuntime, publicPkiRouteRuntime };
