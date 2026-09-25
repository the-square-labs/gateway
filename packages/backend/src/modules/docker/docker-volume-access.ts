/**
 * Rename, label changes, resize and adoption modify one existing volume, so they are gated on
 * `docker:volumes:edit` for `<nodeId>/<volume>`, which node and folder grants resolve to. REST routes, MCP and the AI
 * assistant tools share this constant so their gates cannot drift apart.
 */
export const DOCKER_VOLUME_EDIT_SCOPE = 'docker:volumes:edit';
