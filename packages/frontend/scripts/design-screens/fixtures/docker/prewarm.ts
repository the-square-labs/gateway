/**
 * Background prefetches the console layout starts once a page settled (one list
 * every 350ms). Screens that interact after the reveal (dialogs) run long enough
 * to meet them; the Ingress area already answers that queue with installation
 * data, so these screens reuse it. Pass them last.
 */
export { backgroundPrewarmHandlers as prewarmHandlers } from "../ingress/prewarm";
