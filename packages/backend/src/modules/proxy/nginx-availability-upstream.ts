/**
 * Availability upstreams (D8): one Secure Link socket per member, where only the lease holder's socket listens. A
 * closed socket refuses the connection before any byte of the request is sent, so nginx may retry the next member
 * even for a POST; one failure takes a member out for one second. Retrying a closed socket costs one failed local
 * connect, while a longer timeout keeps a successor whose socket just opened, or a holder after a single transient
 * error, out of rotation with every other member closed: that is a 502 for the whole timeout (stand runs ha18/a, mv1).
 */
export const AVAILABILITY_UPSTREAM_SERVER_PARAMS = 'max_fails=1 fail_timeout=1s';
export const AVAILABILITY_NEXT_UPSTREAM_DIRECTIVE = 'proxy_next_upstream error timeout;';

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
 * Sets proxy_next_upstream explicitly in every location that proxies to an Availability upstream, directly after
 * its proxy_pass. nginx merges a repeated value of this directive, so a template that already sets it stays valid.
 */
export function withAvailabilityNextUpstream(rendered: string, upstreamNames: string[]): string {
  if (upstreamNames.length === 0) return rendered;
  const names = upstreamNames.map(escapeRegExp).join('|');
  const proxyPass = new RegExp(`^([\\t ]*)(proxy_pass[\\t ]+https?://(?:${names})(?=[\\s;/])[^;]*;)`, 'gm');
  return rendered.replace(proxyPass, `$1$2\n$1${AVAILABILITY_NEXT_UPSTREAM_DIRECTIVE}`);
}
