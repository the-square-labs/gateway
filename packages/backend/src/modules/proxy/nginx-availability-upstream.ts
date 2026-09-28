/**
 * Availability upstreams (D8): one Secure Link socket per member, where only the lease holder's socket listens. A
 * closed socket refuses the connection before any byte of the request is sent, so nginx may retry the next member
 * even for a POST; one failure takes a member out for one second. Retrying a closed socket costs one failed local
 * connect, while a longer timeout keeps a successor whose socket just opened, or a holder after a single transient
 * error, out of rotation with every other member closed: that is a 502 for the whole timeout (stand runs ha18/a, mv1).
 */
export const AVAILABILITY_UPSTREAM_SERVER_PARAMS = 'max_fails=1 fail_timeout=1s';

/**
 * Where an Availability upstream sends a request that failed on one member (D6): connect errors and timeouts as
 * before, and a 502/503/504 from the member (a deployment router whose app is not up yet, a member stopping), so the
 * next member answers instead (stand runs a-d, B-5). nginx never passes a non-idempotent request (POST, LOCK, PATCH)
 * on once it reached a member, so only requests that are safe to repeat are retried after a response; a refused
 * member socket (standby, or a holder that is not ready) is retried for every method, since nothing was sent. Tries
 * cover two standby sockets and two members that are not ready besides the one that answers; the timeout bounds the
 * whole retry chain.
 */
export const AVAILABILITY_NEXT_UPSTREAM_DIRECTIVES = [
  'proxy_next_upstream error timeout http_502 http_503 http_504;',
  'proxy_next_upstream_tries 5;',
  'proxy_next_upstream_timeout 10s;',
] as const;

/** Body of a managed Secure Link upstream block. */
export function managedSecureLinkUpstreamBody(socketPaths: string[], availability: boolean): string {
  const params = availability ? ` ${AVAILABILITY_UPSTREAM_SERVER_PARAMS}` : '';
  return `${socketPaths.length > 1 ? '    least_conn;\n' : ''}${socketPaths
    .map((socketPath) => `    server unix:${socketPath}${params};`)
    .join('\n')}\n    keepalive 64;`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sets the next-upstream directives explicitly in every location that proxies to an Availability upstream, directly
 * after its proxy_pass. nginx merges a repeated proxy_next_upstream, so a template that already sets it stays valid;
 * the tries and timeout directives may appear once per location, so they are left to a template that sets them.
 */
export function withAvailabilityNextUpstream(rendered: string, upstreamNames: string[]): string {
  if (upstreamNames.length === 0) return rendered;
  const names = upstreamNames.map(escapeRegExp).join('|');
  const proxyPass = new RegExp(`^([\\t ]*)(proxy_pass[\\t ]+https?://(?:${names})(?=[\\s;/])[^;]*;)`, 'gm');
  const directives = AVAILABILITY_NEXT_UPSTREAM_DIRECTIVES.filter((line) => {
    const name = line.split(' ')[0]!;
    return name === 'proxy_next_upstream' || !new RegExp(`^[\\t ]*${name}[\\t ]`, 'm').test(rendered);
  });
  return rendered.replace(proxyPass, (_match, indent: string, directive: string) =>
    [`${indent}${directive}`, ...directives.map((line) => `${indent}${line}`)].join('\n')
  );
}
