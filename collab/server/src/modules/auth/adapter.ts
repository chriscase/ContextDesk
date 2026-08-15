import type { IdentityV1 } from "@cd-collab/contracts";

export type AuthIdentity = IdentityV1;

export interface AuthSuccess {
  identity: AuthIdentity;
  groups: string[];
}

/**
 * Directory/SSO seam. The password argument exists only for the duration of
 * this call. Implementations must not store, cache, hash, or log it.
 * No module outside `auth` may call this with a password — login routes live here.
 */
export interface AuthAdapter {
  authenticate(username: string, password: string): Promise<AuthSuccess | null>;
}

export class MapAuthAdapter implements AuthAdapter {
  constructor(
    private readonly users: ReadonlyMap<
      string,
      { password: string; identity: AuthIdentity; groups: string[] }
    >,
  ) {}

  async authenticate(
    username: string,
    password: string,
  ): Promise<AuthSuccess | null> {
    const row = this.users.get(username);
    if (!row || row.password !== password) return null;
    return { identity: row.identity, groups: [...row.groups] };
  }
}
