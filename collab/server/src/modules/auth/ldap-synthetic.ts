import type { LdapConfig } from "./ldap-config.js";
import { matchLdapFilter, underBase } from "./ldap-filter.js";
import {
  LdapBindError,
  LdapTimeoutError,
  LdapTlsError,
  LdapUnavailableError,
  type LdapSearchOptions,
  type LdapSearchResult,
  type LdapSession,
  type LdapSessionFactory,
} from "./ldap-session.js";
import { sameIgnoreCase } from "./ldap-resolution.js";

export interface SyntheticPerson {
  dn: string;
  uid: string;
  password: string;
  upn?: string;
  netbios?: string;
  sam?: string;
  attrs: Record<string, string[]>;
  memberOf?: string[];
  delayMs?: number;
}

export interface SyntheticGroup {
  dn: string;
  cn: string;
  members: string[];
  hiddenFromUserBind?: boolean;
}

export interface SyntheticDirectoryOptions {
  people: SyntheticPerson[];
  groups: SyntheticGroup[];
  service?: { dn: string; password: string };
  untrustedCertificate?: boolean;
  forceTimeout?: boolean;
}

interface BoundIdentity {
  kind: "anonymous" | "service" | "user";
  dn: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SyntheticLdapSession implements LdapSession {
  private bound: BoundIdentity | null = null;
  private tlsReady = false;

  constructor(
    private readonly config: LdapConfig,
    private readonly directory: SyntheticDirectoryOptions,
  ) {
    this.tlsReady = !config.starttls && config.url.startsWith("ldaps:");
  }

  async startTLS(): Promise<void> {
    await this.maybeTimeout();
    if (this.config.verifyTls && this.directory.untrustedCertificate) {
      throw new LdapTlsError("unable to verify the first certificate");
    }
    this.tlsReady = true;
  }

  async handshake(): Promise<void> {
    await this.maybeTimeout();
    if (this.config.starttls) {
      await this.startTLS();
      return;
    }
    await this.ensureTransport();
  }

  async bind(dn: string, password: string): Promise<void> {
    await this.ensureTransport();
    await this.maybeTimeout();
    if (this.directory.service && sameIgnoreCase(dn, this.directory.service.dn)) {
      if (password !== this.directory.service.password) throw new LdapBindError();
      this.bound = { kind: "service", dn: this.directory.service.dn };
      return;
    }
    const person = this.people().find((entry) => this.matchesBind(entry, dn));
    if (!person || person.password !== password) throw new LdapBindError();
    this.bound = { kind: "user", dn: person.dn };
  }

  async search(base: string, options: LdapSearchOptions): Promise<LdapSearchResult> {
    await this.ensureTransport();
    await this.maybeTimeout();
    const bound = this.bound;
    if (!bound) throw new LdapBindError("LDAP search requires a bind");
    const entries: Array<Record<string, unknown> & { dn: string }> = [];
    for (const person of this.people()) {
      if (!underBase(person.dn, base) && person.dn.toLowerCase() !== base.toLowerCase()) continue;
      const entry = this.personEntry(person);
      if (matchLdapFilter(entry, options.filter)) {
        entries.push(this.project(entry, options.attributes));
      }
    }
    for (const group of this.directory.groups) {
      if (group.hiddenFromUserBind && bound.kind === "user") {
        if (underBase(group.dn, base) || base.toLowerCase() === group.dn.toLowerCase()) {
          throw new LdapUnavailableError("LDAP No Such Object");
        }
      }
      if (!underBase(group.dn, base) && group.dn.toLowerCase() !== base.toLowerCase()) continue;
      const entry = this.groupEntry(group);
      if (matchLdapFilter(entry, options.filter)) {
        entries.push(this.project(entry, options.attributes));
      }
    }
    return { searchEntries: entries.slice(0, Math.max(1, options.sizeLimit)) };
  }

  async unbind(): Promise<void> {
    this.bound = null;
  }

  private people(): SyntheticPerson[] {
    return this.directory.people;
  }

  private matchesBind(person: SyntheticPerson, dn: string): boolean {
    if (sameIgnoreCase(person.dn, dn)) return true;
    if (person.upn && sameIgnoreCase(person.upn, dn)) return true;
    if (person.netbios && person.sam) {
      const domainUser = `${person.netbios}\\${person.sam}`;
      if (sameIgnoreCase(domainUser, dn)) return true;
    }
    return false;
  }

  private personEntry(person: SyntheticPerson): Record<string, unknown> & { dn: string } {
    const entry: Record<string, unknown> & { dn: string } = {
      dn: person.dn,
      uid: person.uid,
      objectClass: ["inetOrgPerson", "person", "user"],
      ...person.attrs,
    };
    if (person.upn) entry.userPrincipalName = person.upn;
    if (person.sam) entry.sAMAccountName = person.sam;
    if (person.memberOf) entry.memberOf = [...person.memberOf];
    return entry;
  }

  private groupEntry(group: SyntheticGroup): Record<string, unknown> & { dn: string } {
    return {
      dn: group.dn,
      cn: group.cn,
      objectClass: ["groupOfNames", "group"],
      member: [...group.members],
    };
  }

  private project(
    entry: Record<string, unknown> & { dn: string },
    attributes: string[],
  ): Record<string, unknown> & { dn: string } {
    if (attributes.length === 0) return { ...entry };
    const projected: Record<string, unknown> & { dn: string } = { dn: entry.dn };
    for (const attribute of attributes) {
      if (attribute.toLowerCase() === "dn") continue;
      const needle = attribute.toLowerCase();
      for (const [key, value] of Object.entries(entry)) {
        if (key.toLowerCase() === needle) projected[key] = value;
      }
    }
    return projected;
  }

  private async ensureTransport(): Promise<void> {
    if (this.config.starttls && !this.tlsReady) {
      throw new LdapTlsError("StartTLS is required before bind");
    }
    if (!this.config.starttls && this.config.url.startsWith("ldaps:")) {
      if (this.config.verifyTls && this.directory.untrustedCertificate) {
        throw new LdapTlsError("unable to verify the first certificate");
      }
      this.tlsReady = true;
    }
    if (!this.tlsReady && this.config.url.startsWith("ldap:")) {
      throw new LdapTlsError("encrypted LDAP transport is required");
    }
  }

  private async maybeTimeout(): Promise<void> {
    if (this.directory.forceTimeout) {
      throw new LdapTimeoutError();
    }
    const slow = this.people().find((person) => (person.delayMs ?? 0) > this.config.timeoutMs);
    if (slow?.delayMs) {
      await delay(Math.min(slow.delayMs, 5));
      throw new LdapTimeoutError();
    }
  }
}

export function createSyntheticLdapFactory(
  config: LdapConfig,
  directory: SyntheticDirectoryOptions,
): LdapSessionFactory {
  return () => new SyntheticLdapSession(config, directory);
}

export function exampleSyntheticDirectory(): SyntheticDirectoryOptions {
  const peopleBase = "ou=people,dc=example,dc=test";
  const groupBase = "ou=groups,dc=example,dc=test";
  return {
    service: {
      dn: "cn=svc,ou=services,dc=example,dc=test",
      password: "fixture-service-secret",
    },
    people: [
      {
        dn: `uid=alice,${peopleBase}`,
        uid: "alice",
        password: "fixture-alice-secret",
        upn: "alice@example.test",
        netbios: "EXAMPLE",
        sam: "alice",
        attrs: {
          cn: ["Alice Fixture"],
          mail: ["alice@example.test"],
          title: ["Contributor"],
          departmentNumber: ["Blue team"],
        },
        memberOf: [`cn=contributors,${groupBase}`],
      },
      {
        dn: `uid=bob,${peopleBase}`,
        uid: "bob",
        password: "fixture-bob-secret",
        upn: "bob@example.test",
        netbios: "EXAMPLE",
        sam: "bob",
        attrs: {
          cn: ["Bob Fixture"],
        },
        memberOf: [`cn=unmapped,${groupBase}`],
      },
      {
        dn: `uid=samonly,${peopleBase}`,
        uid: "samonly",
        password: "fixture-sam-secret",
        netbios: "EXAMPLE",
        sam: "samonly",
        attrs: {
          cn: ["SAM Only"],
          mail: ["samonly@example.test"],
        },
        memberOf: [`cn=contributors,${groupBase}`],
      },
      {
        dn: `uid=nogroups,${peopleBase}`,
        uid: "nogroups",
        password: "fixture-nogroups-secret",
        attrs: { cn: ["No Groups"] },
      },
      {
        dn: `uid=unsafe,${peopleBase}`,
        uid: "unsafe",
        password: "fixture-unsafe-secret",
        attrs: { cn: [`Unsafe${String.fromCodePoint(0x200b)}Name`] },
        memberOf: [`cn=contributors,${groupBase}`],
      },
      {
        dn: `uid=dups,ou=east,${peopleBase}`,
        uid: "dups",
        password: "fixture-dups-secret",
        attrs: { cn: ["Dup East"] },
      },
      {
        dn: `uid=dups,ou=west,${peopleBase}`,
        uid: "dups",
        password: "fixture-dups-secret",
        attrs: { cn: ["Dup West"] },
      },
    ],
    groups: [
      {
        dn: `cn=contributors,${groupBase}`,
        cn: "contributors",
        members: [`uid=alice,${peopleBase}`, `uid=samonly,${peopleBase}`],
      },
      {
        dn: `cn=unmapped,${groupBase}`,
        cn: "unmapped",
        members: [`uid=bob,${peopleBase}`],
        hiddenFromUserBind: true,
      },
      {
        dn: `cn=admins,${groupBase}`,
        cn: "admins",
        members: [],
      },
      {
        // Nested group: its member is another *group* DN, not a person DN.
        // Present so tests can pin that group resolution is direct-membership
        // only and never silently walks a group-of-groups chain.
        dn: `cn=engineering,${groupBase}`,
        cn: "engineering",
        members: [`cn=contributors,${groupBase}`],
      },
    ],
  };
}
