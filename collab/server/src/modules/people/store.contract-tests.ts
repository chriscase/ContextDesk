/**
 * One behavioral contract, exercised against both MemoryUserProfileStore
 * and PgUserProfileStore so "memory and PostgreSQL parity" is a tested
 * property, not just a claim. Plain async assertion functions (no nested
 * describe/it) so each backend's test file can register them under its own
 * setup/teardown - a fresh store per call for memory, one disposable
 * database shared across the three groups for Postgres.
 */
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { UserProfileStore } from "./store.js";

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function assertLoginSyncContract(store: UserProfileStore): Promise<void> {
  {
    const username = uid("alice");
    const id = `local:${username}`;
    const first = await store.touchOnLogin({
      id,
      username,
      displayName: "Alice Analyst",
      provenance: "local",
      directorySubject: null,
    });
    expect(first.outcome).toBe("ok");
    if (first.outcome !== "ok") throw new Error("unreachable");
    expect(first.profile.displayName).toBe("Alice Analyst");
    expect(first.profile.revision).toBe(1);
    expect(first.profile.directorySyncStatus).toBe("not_synced");

    const second = await store.touchOnLogin({
      id,
      username,
      displayName: "A Completely Different Name",
      provenance: "local",
      directorySubject: null,
    });
    expect(second.outcome).toBe("ok");
    if (second.outcome !== "ok") throw new Error("unreachable");
    // The login flow never overwrites a local profile's display fields -
    // only the person's own edit (updateFields) may.
    expect(second.profile.displayName).toBe("Alice Analyst");
    expect(second.profile.lastSeenAt).not.toBeNull();
  }

  {
    const username = uid("bob");
    const directorySubject = `uid=${username},ou=people,dc=example,dc=test`;
    const created = await store.touchOnLogin({
      id: directorySubject,
      username,
      displayName: username,
      provenance: "ldap",
      directorySubject,
      directoryFields: { displayName: "Bob Reviewer", team: "Blue team" },
    });
    expect(created.outcome).toBe("ok");
    if (created.outcome !== "ok") throw new Error("unreachable");
    expect(created.profile.displayName).toBe("Bob Reviewer");
    expect(created.profile.team).toBe("Blue team");
    expect(created.profile.directorySyncStatus).toBe("synced");

    const synced = await store.touchOnLogin({
      id: directorySubject,
      username,
      displayName: username,
      provenance: "ldap",
      directorySubject,
      directoryFields: { displayName: "Bob Senior Reviewer" },
    });
    expect(synced.outcome).toBe("ok");
    if (synced.outcome !== "ok") throw new Error("unreachable");
    expect(synced.profile.displayName).toBe("Bob Senior Reviewer");
    // A field omitted from this sync (team was not resupplied) keeps its
    // last known value rather than being cleared.
    expect(synced.profile.team).toBe("Blue team");
  }

  {
    const original = uid("carol");
    const renamed = `${original}-renamed`;
    const directorySubject = `uid=${original},ou=people,dc=example,dc=test`;
    await store.touchOnLogin({
      id: directorySubject,
      username: original,
      displayName: original,
      provenance: "ldap",
      directorySubject,
    });
    const result = await store.touchOnLogin({
      id: directorySubject,
      username: renamed,
      displayName: renamed,
      provenance: "ldap",
      directorySubject,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.profile.username).toBe(renamed);
  }

  {
    const username = uid("dave");
    // A local profile already owns this username.
    await store.touchOnLogin({
      id: `local:${username}`,
      username,
      displayName: "Local Dave",
      provenance: "local",
      directorySubject: null,
    });
    const attempt = await store.touchOnLogin({
      id: `uid=${username},ou=people,dc=example,dc=test`,
      username,
      displayName: "Directory Dave",
      provenance: "ldap",
      directorySubject: `uid=${username},ou=people,dc=example,dc=test`,
    });
    expect(attempt.outcome).toBe("collision");
    // Refusing the sync must not have mutated the pre-existing local profile.
    const stillLocal = await store.getByUsername(username);
    expect(stillLocal?.displayName).toBe("Local Dave");
    expect(stillLocal?.provenance).toBe("local");
  }
}

export async function assertFieldUpdateContract(store: UserProfileStore): Promise<void> {
  {
    const username = uid("erin");
    const id = `local:${username}`;
    const created = await store.touchOnLogin({
      id,
      username,
      displayName: "Erin Engineer",
      provenance: "local",
      directorySubject: null,
    });
    if (created.outcome !== "ok") throw new Error("setup failed");
    const result = await store.updateFields(id, { contactOther: "Slack: @erin" }, created.profile.revision);
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") throw new Error("unreachable");
    expect(result.profile.contactOther).toBe("Slack: @erin");
    expect(result.profile.displayName).toBe("Erin Engineer");
    expect(result.profile.revision).toBe(created.profile.revision + 1);
  }

  {
    const username = uid("frank");
    const id = `local:${username}`;
    const created = await store.touchOnLogin({
      id,
      username,
      displayName: "Frank",
      provenance: "local",
      directorySubject: null,
    });
    if (created.outcome !== "ok") throw new Error("setup failed");
    const result = await store.updateFields(id, { contactOther: "new" }, created.profile.revision + 41);
    expect(result.outcome).toBe("stale_revision");
    const unchanged = await store.getById(id);
    expect(unchanged?.contactOther).toBeNull();
  }

  {
    const result = await store.updateFields(`local:${uid("missing")}`, { contactOther: "x" }, 1);
    expect(result.outcome).toBe("not_found");
  }

  {
    const username = uid("grace");
    const id = `local:${username}`;
    const created = await store.touchOnLogin({
      id,
      username,
      displayName: "Grace",
      provenance: "local",
      directorySubject: null,
    });
    if (created.outcome !== "ok") throw new Error("setup failed");
    const suspended = await store.setStatus(id, "suspended", created.profile.revision);
    if (suspended.outcome !== "ok") throw new Error("setup failed");
    const attempt = await store.updateFields(id, { contactOther: "x" }, suspended.profile.revision);
    expect(attempt.outcome).toBe("suspended");
  }

  {
    const username = uid("heidi");
    const id = `local:${username}`;
    const created = await store.touchOnLogin({
      id,
      username,
      displayName: "Heidi",
      provenance: "local",
      directorySubject: null,
    });
    if (created.outcome !== "ok") throw new Error("setup failed");
    const suspended = await store.setStatus(id, "suspended", created.profile.revision);
    if (suspended.outcome !== "ok") throw new Error("setup failed");

    // Regression guard: reactivating with a stale revision must be
    // diagnosed as stale_revision, never as "suspended" (suspended is the
    // very state setStatus exists to change - it must never gate on it).
    const staleReactivate = await store.setStatus(id, "active", suspended.profile.revision + 99);
    expect(staleReactivate.outcome).toBe("stale_revision");

    const reactivated = await store.setStatus(id, "active", suspended.profile.revision);
    expect(reactivated.outcome).toBe("ok");
    if (reactivated.outcome !== "ok") throw new Error("unreachable");
    expect(reactivated.profile.status).toBe("active");
  }
}

export async function assertListContract(store: UserProfileStore): Promise<void> {
  const stamp = uid("list");
  const usernames = [`${stamp}-alpha`, `${stamp}-beta`, `${stamp}-gamma`];
  for (const username of usernames) {
    await store.touchOnLogin({
      id: `local:${username}`,
      username,
      displayName: username,
      provenance: "local",
      directorySubject: null,
    });
  }
  const suspendedTarget = await store.getByUsername(usernames[1]!);
  if (suspendedTarget) {
    await store.setStatus(suspendedTarget.id, "suspended", suspendedTarget.revision);
  }

  const all = await store.list({ term: stamp, status: null, provenance: null, cursor: null, limit: 50 });
  expect(all.people.map((p) => p.username)).toEqual(usernames);

  const activeOnly = await store.list({ term: stamp, status: "active", provenance: null, cursor: null, limit: 50 });
  expect(activeOnly.people.map((p) => p.username)).toEqual([usernames[0], usernames[2]]);

  const page1 = await store.list({ term: stamp, status: null, provenance: null, cursor: null, limit: 2 });
  expect(page1.people.map((p) => p.username)).toEqual([usernames[0], usernames[1]]);
  expect(page1.nextCursor).toBe(usernames[1]);

  const page2 = await store.list({
    term: stamp,
    status: null,
    provenance: null,
    cursor: page1.nextCursor,
    limit: 2,
  });
  expect(page2.people.map((p) => p.username)).toEqual([usernames[2]]);
  expect(page2.nextCursor).toBeNull();
}
