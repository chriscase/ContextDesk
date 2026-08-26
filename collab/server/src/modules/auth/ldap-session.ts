/**
 * Narrow LDAP session used by the adapter and probe so tests can inject a
 * synthetic directory. Live sessions wrap ldapts and stay inside this module.
 */
export interface LdapSearchOptions {
  scope: "base" | "sub";
  filter: string;
  attributes: string[];
  sizeLimit: number;
}

export interface LdapSearchResult {
  searchEntries: Array<Record<string, unknown> & { dn: string }>;
}

export interface LdapSession {
  startTLS(): Promise<void>;
  /**
   * Prove encrypted transport before bind. StartTLS upgrades ldap://.
   * LDAPS implementations must fail here when certificate verification fails
   * rather than reporting that failure as a later bind error.
   */
  handshake(): Promise<void>;
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: LdapSearchOptions): Promise<LdapSearchResult>;
  unbind(): Promise<void>;
}

export type LdapSessionFactory = () => LdapSession;

export class LdapTimeoutError extends Error {
  constructor() {
    super("LDAP operation timed out");
    this.name = "LdapTimeoutError";
  }
}

export class LdapTlsError extends Error {
  constructor(message = "LDAP TLS verification failed") {
    super(message);
    this.name = "LdapTlsError";
  }
}

export class LdapBindError extends Error {
  constructor(message = "LDAP bind failed") {
    super(message);
    this.name = "LdapBindError";
  }
}

export class LdapUnavailableError extends Error {
  constructor(message = "LDAP object is inaccessible") {
    super(message);
    this.name = "LdapUnavailableError";
  }
}

export class DirectoryClaimsUnsafeError extends Error {
  constructor() {
    super("directory claims are unsafe");
    this.name = "DirectoryClaimsUnsafeError";
  }
}

export function firstDirectoryString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string" && first.trim().length > 0) return first;
  if (Buffer.isBuffer(first) && first.byteLength > 0) {
    const text = first.toString("utf8").trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

export function directoryStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out: string[] = [];
  for (const item of values) {
    const text = firstDirectoryString(item);
    if (text) out.push(text);
  }
  return out;
}
