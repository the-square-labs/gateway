import { AppError } from '@/middleware/error-handler.js';

export type ContainerTransition =
  | 'creating'
  | 'stopping'
  | 'restarting'
  | 'killing'
  | 'recreating'
  | 'updating'
  | 'migrating';

/** Proof of ownership for names claimed together with `claim`; only its holder releases them. */
export interface ContainerTransitionClaim {
  readonly nodeId: string;
  readonly names: readonly string[];
  readonly token: symbol;
}

export class DockerContainerTransitions {
  private readonly transitions = new Map<string, ContainerTransition>();
  /** Owner of a transition set through `claim`; `set` and `clear` drop it. */
  private readonly owners = new Map<string, symbol>();

  requireIdle(nodeId: string, name: string) {
    const current = this.get(nodeId, name);
    if (current) {
      throw new AppError(409, 'CONTAINER_BUSY', `Container is currently ${current}`);
    }
  }

  set(nodeId: string, name: string, state: ContainerTransition): boolean {
    if (this.get(nodeId, name) === state) return false;
    const key = this.key(nodeId, name);
    this.transitions.set(key, state);
    this.owners.delete(key);
    return true;
  }

  clear(nodeId: string, name: string) {
    const key = this.key(nodeId, name);
    this.transitions.delete(key);
    this.owners.delete(key);
  }

  /**
   * Claim several names at once, synchronously: either every name was idle and
   * is now held with the given state, or nothing changes and 409 is thrown.
   * Call it with no `await` between the checks it replaces and the claim.
   */
  claim(
    nodeId: string,
    entries: ReadonlyArray<{ name: string; state: ContainerTransition }>
  ): ContainerTransitionClaim {
    const unique = new Map<string, ContainerTransition>();
    for (const entry of entries) if (!unique.has(entry.name)) unique.set(entry.name, entry.state);
    for (const name of unique.keys()) {
      const current = this.get(nodeId, name);
      if (current) throw new AppError(409, 'CONTAINER_BUSY', `Container "${name}" is currently ${current}`);
    }
    const token = Symbol('container-transition-claim');
    for (const [name, state] of unique) {
      const key = this.key(nodeId, name);
      this.transitions.set(key, state);
      this.owners.set(key, token);
    }
    return { nodeId, names: [...unique.keys()], token };
  }

  /** Release a claim's names, skipping any another operation has taken over since. */
  release(claim: ContainerTransitionClaim) {
    for (const name of claim.names) {
      const key = this.key(claim.nodeId, name);
      if (this.owners.get(key) !== claim.token) continue;
      this.transitions.delete(key);
      this.owners.delete(key);
    }
  }

  isClaimedBy(nodeId: string, name: string, claim: ContainerTransitionClaim | undefined): boolean {
    return !!claim && claim.nodeId === nodeId && this.owners.get(this.key(nodeId, name)) === claim.token;
  }

  get(nodeId: string, name: string): ContainerTransition | undefined {
    return this.transitions.get(this.key(nodeId, name));
  }

  private key(nodeId: string, name: string) {
    return `${nodeId}:${name}`;
  }
}
