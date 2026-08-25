import {
  USER_PROFILE_SCHEMA_ID,
  resolveDirectoryIdentityCollision,
  type AvatarMetaV1,
  type CustomAttributeV1,
  type ProfileProvenance,
  type ProfileStatus,
  type UserProfileV1,
} from "@cd-collab/contracts";
import type { Pool } from "pg";

export interface DirectoryMappedFields {
  displayName?: string;
  roleTitle?: string;
  team?: string;
  contactEmail?: string;
}

export interface TouchOnLoginInput {
  id: string;
  username: string;
  displayName: string;
  provenance: ProfileProvenance;
  directorySubject: string | null;
  /**
   * Already-mapped, already-safety-checked directory fields (see
   * directory-mapping.ts mapDirectoryClaimsToProfileFields) for ldap/oidc
   * provenance. Ignored for local provenance, which never syncs display
   * fields from the login flow - see the module doc comment below.
   */
  directoryFields?: DirectoryMappedFields;
}

export type TouchOnLoginResult =
  | { outcome: "ok"; profile: UserProfileV1 }
  | { outcome: "collision" };

export interface ProfileFieldPatch {
  displayName?: string;
  roleTitle?: string | null;
  team?: string | null;
  contactEmail?: string | null;
  contactOther?: string | null;
  avatar?: AvatarMetaV1 | null;
  customAttributes?: CustomAttributeV1[];
}

export type ProfileMutationResult =
  | { outcome: "ok"; profile: UserProfileV1 }
  | { outcome: "not_found" }
  | { outcome: "stale_revision" }
  | { outcome: "suspended" };

export interface AdminPeopleListQuery {
  term: string;
  status: ProfileStatus | null;
  provenance: ProfileProvenance | null;
  cursor: string | null;
  limit: number;
}

export interface AdminPeopleListPage {
  people: UserProfileV1[];
  nextCursor: string | null;
}

/**
 * The canonical, installation-scoped user-profile store.
 *
 * touchOnLogin is the ONLY writer for provenance and directory-owned fields:
 * a local profile's display fields are set once at first login and from
 * then on are owned entirely by the person's own edits (updateFields) -
 * touchOnLogin for provenance "local" only ever advances lastSeenAt. A
 * directory (ldap/oidc) profile's display fields instead follow the
 * directory on every successful login sync, and updateFields refuses to
 * touch them (enforced one layer up, in contracts' assertProfileUpdateAllowed,
 * and re-checked here defense-in-depth via isProfileFieldSelfEditable at the
 * route layer - the store itself does not need to re-derive that rule since
 * it never receives directory-owned fields through ProfileFieldPatch from a
 * self-service caller in the first place).
 *
 * Identity collisions (a directory subject and username lookup disagreeing
 * on which profile they belong to) are refused outright: touchOnLogin
 * returns {outcome: "collision"} and writes nothing. The caller already
 * authenticated the person via the auth adapter, so a collision here never
 * blocks login - it only blocks the profile-sync side effect, which the
 * caller should audit and surface to an admin.
 */
export interface UserProfileStore {
  getById(id: string): Promise<UserProfileV1 | null>;
  getByUsername(username: string): Promise<UserProfileV1 | null>;
  list(query: AdminPeopleListQuery): Promise<AdminPeopleListPage>;
  touchOnLogin(input: TouchOnLoginInput): Promise<TouchOnLoginResult>;
  updateFields(
    id: string,
    patch: ProfileFieldPatch,
    expectedRevision: number,
  ): Promise<ProfileMutationResult>;
  setStatus(
    id: string,
    status: ProfileStatus,
    expectedRevision: number,
  ): Promise<ProfileMutationResult>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

export class MemoryUserProfileStore implements UserProfileStore {
  private readonly byId = new Map<string, UserProfileV1>();

  capture(): unknown {
    return { profiles: [...this.byId.entries()] };
  }

  restore(snapshot: unknown): void {
    const state = snapshot as { profiles: [string, UserProfileV1][] };
    this.byId.clear();
    for (const [id, profile] of state.profiles) this.byId.set(id, { ...profile });
  }

  private findByUsername(username: string): UserProfileV1 | null {
    const needle = username.toLocaleLowerCase("en-US");
    for (const profile of this.byId.values()) {
      if (profile.username.toLocaleLowerCase("en-US") === needle) return profile;
    }
    return null;
  }

  private findByDirectorySubject(directorySubject: string): UserProfileV1 | null {
    for (const profile of this.byId.values()) {
      if (profile.directorySubject === directorySubject) return profile;
    }
    return null;
  }

  async getById(id: string): Promise<UserProfileV1 | null> {
    const profile = this.byId.get(id);
    return profile ? { ...profile } : null;
  }

  async getByUsername(username: string): Promise<UserProfileV1 | null> {
    const profile = this.findByUsername(username);
    return profile ? { ...profile } : null;
  }

  async list(query: AdminPeopleListQuery): Promise<AdminPeopleListPage> {
    const term = query.term.toLocaleLowerCase("en-US");
    let rows = [...this.byId.values()].filter((profile) => {
      if (query.status && profile.status !== query.status) return false;
      if (query.provenance && profile.provenance !== query.provenance) return false;
      if (term.length === 0) return true;
      return (
        profile.username.toLocaleLowerCase("en-US").includes(term) ||
        profile.displayName.toLocaleLowerCase("en-US").includes(term)
      );
    });
    rows.sort((a, b) => a.username.localeCompare(b.username));
    if (query.cursor) {
      rows = rows.filter((profile) => profile.username > query.cursor!);
    }
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page[page.length - 1]?.username ?? null) : null;
    return { people: page.map((profile) => ({ ...profile })), nextCursor };
  }

  async touchOnLogin(input: TouchOnLoginInput): Promise<TouchOnLoginResult> {
    if (input.provenance === "local") {
      const existing = this.byId.get(input.id);
      if (existing) {
        const updated: UserProfileV1 = { ...existing, lastSeenAt: nowIso(), updatedAt: nowIso() };
        this.byId.set(input.id, updated);
        return { outcome: "ok", profile: { ...updated } };
      }
      const created = newProfile(input);
      this.byId.set(input.id, created);
      return { outcome: "ok", profile: { ...created } };
    }

    const directorySubject = input.directorySubject;
    if (!directorySubject) {
      throw new Error("directory-provenance touchOnLogin requires directorySubject");
    }
    const byUsername = this.findByUsername(input.username);
    const byDirectorySubject = this.findByDirectorySubject(directorySubject);
    const resolution = resolveDirectoryIdentityCollision({
      incomingUsername: input.username,
      incomingDirectorySubject: directorySubject,
      byUsername: byUsername ? { id: byUsername.id, directorySubject: byUsername.directorySubject } : null,
      byDirectorySubject: byDirectorySubject ? { id: byDirectorySubject.id, username: byDirectorySubject.username } : null,
    });
    if (resolution === "collision") return { outcome: "collision" };
    if (resolution === "create") {
      const created = newProfile(input);
      this.byId.set(created.id, created);
      return { outcome: "ok", profile: { ...created } };
    }
    // "update": byDirectorySubject is guaranteed non-null by the resolver contract.
    const target = byDirectorySubject as UserProfileV1;
    // Only claim "synced" when this call actually supplied mapped directory
    // fields; a bare login-time touch with no claims to map (V1's live auth
    // flow, pending a claims-fetching adapter) must not overstate itself.
    const synced = input.directoryFields !== undefined;
    const updated: UserProfileV1 = {
      ...target,
      username: input.username,
      displayName: input.directoryFields?.displayName ?? target.displayName,
      roleTitle: input.directoryFields?.roleTitle ?? target.roleTitle,
      team: input.directoryFields?.team ?? target.team,
      contactEmail: input.directoryFields?.contactEmail ?? target.contactEmail,
      directorySyncStatus: synced ? "synced" : target.directorySyncStatus,
      directorySyncedAt: synced ? nowIso() : target.directorySyncedAt,
      lastSeenAt: nowIso(),
      updatedAt: nowIso(),
      revision: target.revision + 1,
    };
    this.byId.set(target.id, updated);
    return { outcome: "ok", profile: { ...updated } };
  }

  async updateFields(
    id: string,
    patch: ProfileFieldPatch,
    expectedRevision: number,
  ): Promise<ProfileMutationResult> {
    const existing = this.byId.get(id);
    if (!existing) return { outcome: "not_found" };
    if (existing.status !== "active") return { outcome: "suspended" };
    if (existing.revision !== expectedRevision) return { outcome: "stale_revision" };
    const updated: UserProfileV1 = {
      ...existing,
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.roleTitle !== undefined ? { roleTitle: patch.roleTitle } : {}),
      ...(patch.team !== undefined ? { team: patch.team } : {}),
      ...(patch.contactEmail !== undefined ? { contactEmail: patch.contactEmail } : {}),
      ...(patch.contactOther !== undefined ? { contactOther: patch.contactOther } : {}),
      ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      ...(patch.customAttributes !== undefined ? { customAttributes: patch.customAttributes } : {}),
      revision: existing.revision + 1,
      updatedAt: nowIso(),
    };
    this.byId.set(id, updated);
    return { outcome: "ok", profile: { ...updated } };
  }

  async setStatus(
    id: string,
    status: ProfileStatus,
    expectedRevision: number,
  ): Promise<ProfileMutationResult> {
    const existing = this.byId.get(id);
    if (!existing) return { outcome: "not_found" };
    if (existing.revision !== expectedRevision) return { outcome: "stale_revision" };
    const updated: UserProfileV1 = { ...existing, status, revision: existing.revision + 1, updatedAt: nowIso() };
    this.byId.set(id, updated);
    return { outcome: "ok", profile: { ...updated } };
  }
}

function newProfile(input: TouchOnLoginInput): UserProfileV1 {
  const now = nowIso();
  // Same honesty rule as the update path above: "synced" only when this
  // call actually supplied mapped directory fields to create the row with.
  const directorySynced = input.provenance !== "local" && input.directoryFields !== undefined;
  return {
    schemaId: USER_PROFILE_SCHEMA_ID,
    id: input.id,
    username: input.username,
    displayName: input.directoryFields?.displayName ?? input.displayName,
    roleTitle: input.directoryFields?.roleTitle ?? null,
    team: input.directoryFields?.team ?? null,
    contactEmail: input.directoryFields?.contactEmail ?? null,
    contactOther: null,
    avatar: null,
    status: "active",
    provenance: input.provenance,
    directorySubject: input.directorySubject,
    directorySyncStatus: directorySynced ? "synced" : "not_synced",
    directorySyncedAt: directorySynced ? now : null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    customAttributes: [],
    revision: 1,
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

interface UserProfileRow {
  id: string;
  username: string;
  display_name: string;
  role_title: string | null;
  team: string | null;
  contact_email: string | null;
  contact_other: string | null;
  avatar_kind: "initials" | "url" | null;
  avatar_value: string | null;
  status: ProfileStatus;
  provenance: ProfileProvenance;
  directory_subject: string | null;
  directory_sync_status: UserProfileV1["directorySyncStatus"];
  directory_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
  custom_attributes: CustomAttributeV1[];
  revision: number;
}

function rowToProfile(row: UserProfileRow): UserProfileV1 {
  return {
    schemaId: USER_PROFILE_SCHEMA_ID,
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleTitle: row.role_title,
    team: row.team,
    contactEmail: row.contact_email,
    contactOther: row.contact_other,
    avatar: row.avatar_kind && row.avatar_value ? { kind: row.avatar_kind, value: row.avatar_value } : null,
    status: row.status,
    provenance: row.provenance,
    directorySubject: row.directory_subject,
    directorySyncStatus: row.directory_sync_status,
    directorySyncedAt: row.directory_synced_at ? row.directory_synced_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    customAttributes: row.custom_attributes,
    revision: row.revision,
  };
}

const SELECT_ONE = `SELECT * FROM user_profiles WHERE id = $1`;

export class PgUserProfileStore implements UserProfileStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async getById(id: string): Promise<UserProfileV1 | null> {
    const result = await this.pool.query(SELECT_ONE, [id]);
    const row = result.rows[0] as UserProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  async getByUsername(username: string): Promise<UserProfileV1 | null> {
    const result = await this.pool.query(
      `SELECT * FROM user_profiles WHERE lower(username) = lower($1)`,
      [username],
    );
    const row = result.rows[0] as UserProfileRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  async list(query: AdminPeopleListQuery): Promise<AdminPeopleListPage> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.provenance) {
      params.push(query.provenance);
      conditions.push(`provenance = $${params.length}`);
    }
    if (query.term.length > 0) {
      params.push(`%${escapeLike(query.term)}%`);
      const idx = params.length;
      conditions.push(`(username ILIKE $${idx} ESCAPE '\\' OR display_name ILIKE $${idx} ESCAPE '\\')`);
    }
    if (query.cursor) {
      params.push(query.cursor);
      conditions.push(`username > $${params.length}`);
    }
    params.push(query.limit + 1);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM user_profiles ${where} ORDER BY username ASC LIMIT $${params.length}`,
      params,
    );
    const rows = (result.rows as UserProfileRow[]).map(rowToProfile);
    const truncated = rows.length > query.limit;
    const page = truncated ? rows.slice(0, query.limit) : rows;
    return { people: page, nextCursor: truncated ? (page[page.length - 1]?.username ?? null) : null };
  }

  async touchOnLogin(input: TouchOnLoginInput): Promise<TouchOnLoginResult> {
    if (input.provenance === "local") {
      const result = await this.pool.query(
        `INSERT INTO user_profiles (
           id, username, display_name, status, provenance, directory_subject,
           directory_sync_status, last_seen_at
         ) VALUES ($1, $2, $3, 'active', 'local', NULL, 'not_synced', now())
         ON CONFLICT (id) DO UPDATE
           SET last_seen_at = now(), updated_at = now()
         RETURNING *`,
        [input.id, input.username, input.displayName],
      );
      return { outcome: "ok", profile: rowToProfile(result.rows[0] as UserProfileRow) };
    }

    const directorySubject = input.directorySubject;
    if (!directorySubject) {
      throw new Error("directory-provenance touchOnLogin requires directorySubject");
    }
    const [byUsernameResult, byDirectorySubjectResult] = await Promise.all([
      this.pool.query(`SELECT id, directory_subject FROM user_profiles WHERE lower(username) = lower($1)`, [
        input.username,
      ]),
      this.pool.query(`SELECT id, username FROM user_profiles WHERE directory_subject = $1`, [directorySubject]),
    ]);
    const byUsernameRow = byUsernameResult.rows[0] as { id: string; directory_subject: string | null } | undefined;
    const byDirectorySubjectRow = byDirectorySubjectResult.rows[0] as { id: string; username: string } | undefined;
    const resolution = resolveDirectoryIdentityCollision({
      incomingUsername: input.username,
      incomingDirectorySubject: directorySubject,
      byUsername: byUsernameRow ? { id: byUsernameRow.id, directorySubject: byUsernameRow.directory_subject } : null,
      byDirectorySubject: byDirectorySubjectRow
        ? { id: byDirectorySubjectRow.id, username: byDirectorySubjectRow.username }
        : null,
    });
    if (resolution === "collision") return { outcome: "collision" };

    // Only claim "synced" when this call actually supplied mapped directory
    // fields; a bare login-time touch with no claims to map (V1's live auth
    // flow, pending a claims-fetching adapter) must not overstate itself.
    const synced = input.directoryFields !== undefined;

    if (resolution === "create") {
      const result = await this.pool.query(
        `INSERT INTO user_profiles (
           id, username, display_name, role_title, team, contact_email, status, provenance,
           directory_subject, directory_sync_status, directory_synced_at, last_seen_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, CASE WHEN $9 = 'synced' THEN now() ELSE NULL END, now())
         RETURNING *`,
        [
          input.id,
          input.username,
          input.directoryFields?.displayName ?? input.displayName,
          input.directoryFields?.roleTitle ?? null,
          input.directoryFields?.team ?? null,
          input.directoryFields?.contactEmail ?? null,
          input.provenance,
          directorySubject,
          synced ? "synced" : "not_synced",
        ],
      );
      return { outcome: "ok", profile: rowToProfile(result.rows[0] as UserProfileRow) };
    }

    // "update"
    const targetId = (byDirectorySubjectRow as { id: string }).id;
    const result = await this.pool.query(
      `UPDATE user_profiles SET
         username = $2,
         display_name = COALESCE($3, display_name),
         role_title = COALESCE($4, role_title),
         team = COALESCE($5, team),
         contact_email = COALESCE($6, contact_email),
         directory_sync_status = CASE WHEN $7 THEN 'synced' ELSE directory_sync_status END,
         directory_synced_at = CASE WHEN $7 THEN now() ELSE directory_synced_at END,
         last_seen_at = now(),
         updated_at = now(),
         revision = revision + 1
       WHERE id = $1
       RETURNING *`,
      [
        targetId,
        input.username,
        input.directoryFields?.displayName ?? null,
        input.directoryFields?.roleTitle ?? null,
        input.directoryFields?.team ?? null,
        input.directoryFields?.contactEmail ?? null,
        synced,
      ],
    );
    return { outcome: "ok", profile: rowToProfile(result.rows[0] as UserProfileRow) };
  }

  async updateFields(
    id: string,
    patch: ProfileFieldPatch,
    expectedRevision: number,
  ): Promise<ProfileMutationResult> {
    const sets: string[] = ["revision = revision + 1", "updated_at = now()"];
    const params: unknown[] = [];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.displayName !== undefined) addSet("display_name", patch.displayName);
    if (patch.roleTitle !== undefined) addSet("role_title", patch.roleTitle);
    if (patch.team !== undefined) addSet("team", patch.team);
    if (patch.contactEmail !== undefined) addSet("contact_email", patch.contactEmail);
    if (patch.contactOther !== undefined) addSet("contact_other", patch.contactOther);
    if (patch.avatar !== undefined) {
      addSet("avatar_kind", patch.avatar?.kind ?? null);
      addSet("avatar_value", patch.avatar?.value ?? null);
    }
    if (patch.customAttributes !== undefined) {
      addSet("custom_attributes", JSON.stringify(patch.customAttributes));
    }
    params.push(id);
    const idIdx = params.length;
    params.push(expectedRevision);
    const revIdx = params.length;
    const result = await this.pool.query(
      `UPDATE user_profiles SET ${sets.join(", ")}
       WHERE id = $${idIdx} AND revision = $${revIdx} AND status = 'active'
       RETURNING *`,
      params,
    );
    if (result.rowCount === 1) {
      return { outcome: "ok", profile: rowToProfile(result.rows[0] as UserProfileRow) };
    }
    // updateFields gated the UPDATE on status = 'active', so a 0-row result
    // really can mean "suspended" - check for it.
    return this.classifyMutationMiss(id, { statusGated: true });
  }

  async setStatus(
    id: string,
    status: ProfileStatus,
    expectedRevision: number,
  ): Promise<ProfileMutationResult> {
    // Deliberately no status guard here: setStatus is how an admin
    // reactivates a suspended profile, so the current status can never be
    // the reason this UPDATE affects 0 rows.
    const result = await this.pool.query(
      `UPDATE user_profiles SET status = $3, revision = revision + 1, updated_at = now()
       WHERE id = $1 AND revision = $2
       RETURNING *`,
      [id, expectedRevision, status],
    );
    if (result.rowCount === 1) {
      return { outcome: "ok", profile: rowToProfile(result.rows[0] as UserProfileRow) };
    }
    return this.classifyMutationMiss(id, { statusGated: false });
  }

  private async classifyMutationMiss(
    id: string,
    options: { statusGated: boolean },
  ): Promise<ProfileMutationResult> {
    const current = await this.pool.query(`SELECT status FROM user_profiles WHERE id = $1`, [id]);
    const row = current.rows[0] as { status: ProfileStatus } | undefined;
    if (!row) return { outcome: "not_found" };
    if (options.statusGated && row.status !== "active") return { outcome: "suspended" };
    return { outcome: "stale_revision" };
  }
}
