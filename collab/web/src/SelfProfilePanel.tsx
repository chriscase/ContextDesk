import {
  LOCAL_ONLY_FIELDS,
  PROFILE_CONTACT_EMAIL_MAX,
  PROFILE_CONTACT_OTHER_MAX,
  PROFILE_CUSTOM_ATTR_MAX_COUNT,
  PROFILE_CUSTOM_ATTR_VALUE_MAX,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_ROLE_TITLE_MAX,
  PROFILE_TEAM_MAX,
  USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
  isProfileFieldSelfEditable,
  parseUserProfile,
  parseUserProfileError,
  parseUserProfileUpdateRequest,
  type AvatarMetaV1,
  type CustomAttributeV1,
  type DirectorySyncStatus,
  type ProfileProvenance,
  type ProfileStatus,
  type SelfEditableField,
  type UserProfileUpdateRequestV1,
  type UserProfileV1,
} from "@cd-collab/contracts/admin";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AUTH_LOST_EVENT, withBrowserMutationCsrf } from "./protected-api.js";

const AVATAR_VALUE_MAX = 2048;

const STATUS_LABELS: Record<ProfileStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  disabled: "Disabled",
};

const PROVENANCE_LABELS: Record<ProfileProvenance, string> = {
  local: "Local account",
  ldap: "LDAP directory",
  oidc: "Sign-in provider (OIDC)",
  imported_historical: "Imported historical record",
};

const SYNC_LABELS: Record<DirectorySyncStatus, string> = {
  not_synced: "Not synced from a directory",
  synced: "In sync with the directory",
  stale: "May be out of date",
  error: "Last directory sync did not complete",
  disabled: "Directory sync is turned off",
};

const FIELD_LABELS: Record<SelfEditableField, string> = {
  displayName: "Display name",
  roleTitle: "Role title",
  team: "Team",
  contactEmail: "Work email",
  contactOther: "Other contact",
  avatar: "Avatar",
  customAttributes: "Custom fields",
};

type AvatarKindChoice = "none" | "initials" | "url";

interface Draft {
  displayName: string;
  roleTitle: string;
  team: string;
  contactEmail: string;
  contactOther: string;
  avatarKind: AvatarKindChoice;
  avatarValue: string;
  customAttributes: CustomAttributeV1[];
}

interface FieldError {
  field: string;
  message: string;
}

async function profileFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT, { detail: { status: 401 } }));
  }
  return response;
}

function draftFrom(profile: UserProfileV1): Draft {
  return {
    displayName: profile.displayName,
    roleTitle: profile.roleTitle ?? "",
    team: profile.team ?? "",
    contactEmail: profile.contactEmail ?? "",
    contactOther: profile.contactOther ?? "",
    avatarKind: profile.avatar?.kind ?? "none",
    avatarValue: profile.avatar?.value ?? "",
    customAttributes: profile.customAttributes.map((attribute) => ({
      key: attribute.key,
      value: attribute.value,
    })),
  };
}

function compactAttributes(attributes: readonly CustomAttributeV1[]): CustomAttributeV1[] {
  return attributes.filter((attribute) => attribute.key.trim() !== "" || attribute.value.trim() !== "");
}

function sameDraft(left: Draft, right: Draft): boolean {
  return JSON.stringify({
    ...left,
    customAttributes: compactAttributes(left.customAttributes),
  }) === JSON.stringify({
    ...right,
    customAttributes: compactAttributes(right.customAttributes),
  });
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function directoryLinkLabel(profile: UserProfileV1): string {
  if (profile.provenance === "ldap") {
    return profile.directorySubject
      ? "Linked to the LDAP directory (technical identifier hidden)"
      : "LDAP directory linkage unavailable";
  }
  if (profile.provenance === "oidc") {
    return profile.directorySubject
      ? "Linked to the sign-in provider (technical identifier hidden)"
      : "Sign-in provider linkage unavailable";
  }
  if (profile.provenance === "imported_historical") return "Historical attribution only";
  return "Not linked to a directory";
}

function avatarPreview(profile: UserProfileV1, draft: Draft): string {
  if (draft.avatarKind === "initials" && draft.avatarValue.trim()) {
    return draft.avatarValue.trim().slice(0, 4).toUpperCase();
  }
  const fromName = draft.displayName.trim() || profile.displayName;
  return fromName.slice(0, 1).toUpperCase() || "?";
}

function formatAvatar(avatar: AvatarMetaV1 | null, fallback: string): string {
  if (!avatar) return fallback;
  if (avatar.kind === "initials") return `Initials ${avatar.value}`;
  return `Image ${avatar.value}`;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function avatarPayload(draft: Draft): AvatarMetaV1 | null {
  if (draft.avatarKind === "none") return null;
  return { kind: draft.avatarKind, value: draft.avatarValue.trim() };
}

function fieldEditable(field: SelfEditableField, provenance: ProfileProvenance): boolean {
  return isProfileFieldSelfEditable(field, provenance);
}

function directoryOwned(field: SelfEditableField, provenance: ProfileProvenance): boolean {
  if (provenance !== "ldap" && provenance !== "oidc") return false;
  return !fieldEditable(field, provenance) && !(LOCAL_ONLY_FIELDS as readonly string[]).includes(field);
}

function buildUpdate(saved: UserProfileV1, draft: Draft): UserProfileUpdateRequestV1 | FieldError {
  const request: UserProfileUpdateRequestV1 = {
    schemaId: USER_PROFILE_UPDATE_REQUEST_SCHEMA_ID,
    expectedRevision: saved.revision,
  };
  const nextAvatar = avatarPayload(draft);
  const nextAttrs = compactAttributes(draft.customAttributes);

  if (fieldEditable("displayName", saved.provenance) && draft.displayName.trim() !== saved.displayName) {
    if (draft.displayName.trim() === "") {
      return { field: "displayName", message: "Enter a display name." };
    }
    request.displayName = draft.displayName;
  }
  if (fieldEditable("roleTitle", saved.provenance) && optionalText(draft.roleTitle) !== saved.roleTitle) {
    request.roleTitle = optionalText(draft.roleTitle);
  }
  if (fieldEditable("team", saved.provenance) && optionalText(draft.team) !== saved.team) {
    request.team = optionalText(draft.team);
  }
  if (fieldEditable("contactEmail", saved.provenance) && optionalText(draft.contactEmail) !== saved.contactEmail) {
    request.contactEmail = optionalText(draft.contactEmail);
  }
  if (fieldEditable("contactOther", saved.provenance) && optionalText(draft.contactOther) !== saved.contactOther) {
    request.contactOther = optionalText(draft.contactOther);
  }
  if (fieldEditable("avatar", saved.provenance) && JSON.stringify(nextAvatar) !== JSON.stringify(saved.avatar)) {
    request.avatar = nextAvatar;
  }
  if (
    fieldEditable("customAttributes", saved.provenance)
    && JSON.stringify(nextAttrs) !== JSON.stringify(saved.customAttributes)
  ) {
    request.customAttributes = nextAttrs;
  }

  try {
    return parseUserProfileUpdateRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "These changes are not valid.";
    const fieldMatch = /^\$\.([A-Za-z]+)/.exec(message);
    return { field: fieldMatch?.[1] ?? "form", message: humanizeContractMessage(message) };
  }
}

function humanizeContractMessage(message: string): string {
  if (message.includes("email")) return "Enter a valid email address, or leave this blank.";
  if (message.includes("https")) return "Image avatars must use an https address.";
  if (message.includes("initials")) return "Initials can be at most four characters.";
  if (message.includes("duplicate custom attribute")) return "Each custom field needs a different name.";
  if (message.includes("ASCII")) return "Custom field names must start with a letter or digit and use only letters, digits, _ or -.";
  if (message.includes("control characters") || message.includes("invisible")) {
    return "Remove hidden or control characters from this field.";
  }
  if (message.includes("at most")) return message.replace(/^\$\.[^:]+:\s*/, "");
  return "Check this field and try again.";
}

function statusMessageFor(response: Response, errorCode: string | null, action: string): string {
  if (errorCode === "stale_revision" || response.status === 409) {
    return "This profile changed since you started editing. Your unsaved edits are still here.";
  }
  if (errorCode === "suspended" || (response.status === 403 && errorCode === "suspended")) {
    return "This account is suspended, so profile changes cannot be saved until an administrator restores it.";
  }
  if (errorCode === "field_not_editable") {
    return "That field is owned by the directory and cannot be changed here.";
  }
  if (errorCode === "invalid_request" || response.status === 400) {
    return `${action} was rejected because the request is invalid. No change was saved.`;
  }
  if (errorCode === "unavailable" || response.status === 503) {
    return "Your profile is temporarily unavailable. No change was saved.";
  }
  if (response.status === 403) {
    return `${action} is not allowed for the current session. No change was saved.`;
  }
  return `${action} failed. No change was saved.`;
}

function provenanceExplainer(provenance: ProfileProvenance): string {
  if (provenance === "ldap") {
    return "Display name, role title, team, and work email come from your organization's LDAP directory. This page cannot change LDAP. You can still update other contact details, avatar, and custom fields that live only in this workspace.";
  }
  if (provenance === "oidc") {
    return "Display name, role title, team, and work email come from your sign-in provider. This page cannot change that directory. You can still update other contact details, avatar, and custom fields that live only in this workspace.";
  }
  if (provenance === "imported_historical") {
    return "This is an imported historical record. It cannot sign in or hold access, and nothing on this page is editable.";
  }
  return "This is a local workspace account. You can edit every field the server allows, including name, role title, team, and contact details.";
}

function LeaveDialog(props: { onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      className="profile-confirm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <section
        className="profile-confirm__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-leave-title"
        aria-describedby="profile-leave-copy"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onCancel();
          if (event.key === "Tab" && !event.shiftKey && document.activeElement === confirmRef.current) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
          if (event.key === "Tab" && event.shiftKey && document.activeElement === cancelRef.current) {
            event.preventDefault();
            confirmRef.current?.focus();
          }
        }}
      >
        <h2 id="profile-leave-title">Leave without saving?</h2>
        <p id="profile-leave-copy">
          You have unsaved profile changes. Leave and discard them, or stay on this page to keep editing.
        </p>
        <div className="profile-confirm__actions">
          <button ref={cancelRef} type="button" onClick={props.onCancel}>
            Stay on this page
          </button>
          <button
            ref={confirmRef}
            className="profile-button profile-button--danger"
            type="button"
            onClick={props.onConfirm}
          >
            Discard changes
          </button>
        </div>
      </section>
    </div>
  );
}

export function SelfProfilePanel(props: {
  readOnly: boolean;
  leaveRequest: boolean;
  onLeaveConfirm: () => void;
  onLeaveCancel: () => void;
  onSaved: (profile: UserProfileV1) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusedOnLoadRef = useRef(false);
  const formId = useId();

  const [saved, setSaved] = useState<UserProfileV1 | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [stale, setStale] = useState<UserProfileV1 | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const load = useCallback(async (preserveDraft: boolean) => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await profileFetch("/api/profile/me");
      if (!response.ok) {
        let code: string | null = null;
        try {
          code = parseUserProfileError(await response.json()).error;
        } catch {
          code = null;
        }
        if (response.status === 401) return;
        setSaved(null);
        if (!preserveDraft) setDraft(null);
        setLoadError(
          code === "unavailable" || response.status === 503
            ? "Your profile is temporarily unavailable. Try again in a moment."
            : "Your profile could not be loaded.",
        );
        return;
      }
      const profile = parseUserProfile(await response.json());
      setSaved(profile);
      setDraft((current) => (preserveDraft && current ? current : draftFrom(profile)));
      setLoadError("");
      return profile;
    } catch {
      setSaved(null);
      if (!preserveDraft) setDraft(null);
      setLoadError("Your profile could not be validated. Nothing else was changed.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (loading || props.leaveRequest || focusedOnLoadRef.current || !saved) return;
    focusedOnLoadRef.current = true;
    headingRef.current?.focus();
  }, [loading, props.leaveRequest, saved]);

  const dirty = saved !== null && draft !== null && !sameDraft(draft, draftFrom(saved));
  const canSave = !props.readOnly && saved?.status === "active" && dirty && !saving;

  const onDirtyChange = props.onDirtyChange;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setNotice("");
    setFieldErrors((current) => current.filter((error) => error.field !== key && error.field !== "form"));
  }

  function cancelEdits() {
    if (!saved) return;
    setDraft(draftFrom(saved));
    setFieldErrors([]);
    setFormError("");
    setNotice("Your unsaved edits were discarded.");
    setStale(null);
    setReviewOpen(false);
    headingRef.current?.focus();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!saved || !draft || !canSave) return;
    const update = buildUpdate(saved, draft);
    if ("field" in update) {
      setFieldErrors([update]);
      setFormError(update.message);
      return;
    }
    if (
      update.displayName === undefined
      && update.roleTitle === undefined
      && update.team === undefined
      && update.contactEmail === undefined
      && update.contactOther === undefined
      && update.avatar === undefined
      && update.customAttributes === undefined
    ) {
      setNotice("Nothing to save — this matches the saved profile.");
      return;
    }
    setSaving(true);
    setFormError("");
    setNotice("");
    try {
      const response = await profileFetch("/api/profile/me", withBrowserMutationCsrf({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }));
      if (response.ok) {
        const profile = parseUserProfile(await response.json());
        setSaved(profile);
        setDraft(draftFrom(profile));
        setStale(null);
        setReviewOpen(false);
        setNotice("Profile saved. Future displays will use these details. Past records keep their original names.");
        props.onSaved(profile);
        saveRef.current?.focus();
        return;
      }
      let code: string | null = null;
      try {
        code = parseUserProfileError(await response.json()).error;
      } catch {
        code = null;
      }
      if (response.status === 401) return;
      if (code === "stale_revision" || response.status === 409) {
        const latest = await load(true);
        if (latest) {
          setStale(latest);
          setReviewOpen(true);
        }
        setFormError(statusMessageFor(response, code, "Save"));
        return;
      }
      setFormError(statusMessageFor(response, code, "Save"));
    } catch {
      setFormError("Save failed because the response could not be validated. No change was saved.");
    } finally {
      setSaving(false);
    }
  }

  async function reloadSaved() {
    const latest = await load(false);
    if (latest) {
      setStale(null);
      setReviewOpen(false);
      setFormError("");
      setNotice("Loaded the saved profile. Your previous unsaved edits were replaced.");
      headingRef.current?.focus();
    }
  }

  function fieldError(field: string): string | undefined {
    return fieldErrors.find((error) => error.field === field)?.message;
  }

  function describedBy(field: string, extra?: string): string | undefined {
    const ids = [
      fieldError(field) ? `${formId}-${field}-error` : null,
      extra,
    ].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : undefined;
  }

  if (loading && !saved) {
    return (
      <section className="self-profile" aria-labelledby="self-profile-title" aria-busy="true">
        <header className="self-profile__masthead">
          <p className="self-profile__eyebrow">Account</p>
          <h2 className="self-profile__title" id="self-profile-title" tabIndex={-1} ref={headingRef}>
            My profile
          </h2>
        </header>
        <p className="self-profile__status" role="status">
          Loading your profile…
        </p>
      </section>
    );
  }

  if (!saved || !draft) {
    return (
      <section className="self-profile" aria-labelledby="self-profile-title">
        <header className="self-profile__masthead">
          <p className="self-profile__eyebrow">Account</p>
          <h2 className="self-profile__title" id="self-profile-title" tabIndex={-1} ref={headingRef}>
            My profile
          </h2>
        </header>
        <p className="self-profile__message self-profile__message--error" role="alert" tabIndex={-1} ref={errorRef}>
          {loadError || "Your profile is not available."}
        </p>
        <button type="button" onClick={() => void load(false)}>
          Try again
        </button>
      </section>
    );
  }

  const localAccount = saved.provenance === "local";
  const directoryAccount = saved.provenance === "ldap" || saved.provenance === "oidc";
  const editingBlocked = props.readOnly || saved.status !== "active";
  const anyEditable = (Object.keys(FIELD_LABELS) as SelfEditableField[]).some((field) =>
    fieldEditable(field, saved.provenance),
  );

  return (
    <section className="self-profile" aria-labelledby="self-profile-title">
      <header className="self-profile__masthead">
        <p className="self-profile__eyebrow">Account</p>
        <h2 className="self-profile__title" id="self-profile-title" tabIndex={-1} ref={headingRef}>
          My profile
        </h2>
        <p>
          Current details for how you appear in this workspace. Notes, comments, and decisions
          already recorded keep the name written at the time — changing this page never rewrites history.
        </p>
      </header>

      <article className="self-profile__identity" aria-label="Current identity">
        <div className="self-profile__avatar" aria-hidden="true" data-initial={avatarPreview(saved, draft)} />
        <div className="self-profile__identity-copy">
          <p className="self-profile__display-name">{draft.displayName.trim() || saved.displayName}</p>
          <p className="self-profile__username">@{saved.username}</p>
          <p className="self-profile__meta">
            {[
              saved.roleTitle || draft.roleTitle || null,
              saved.team || draft.team || null,
            ].filter(Boolean).join(" · ") || "No role title or team recorded"}
          </p>
          <p className="self-profile__chips">
            <span className={`self-profile__chip self-profile__chip--${saved.status}`}>
              {STATUS_LABELS[saved.status]}
            </span>
            <span className="self-profile__chip">{PROVENANCE_LABELS[saved.provenance]}</span>
          </p>
        </div>
      </article>

      <p className="self-profile__explainer" role="note">
        {provenanceExplainer(saved.provenance)}
      </p>

      {saved.status !== "active" ? (
        <p className="self-profile__message self-profile__message--warning" role="status">
          This account is {STATUS_LABELS[saved.status].toLowerCase()}, so profile changes cannot be saved
          until an administrator restores it.
        </p>
      ) : null}
      {props.readOnly ? (
        <p className="self-profile__message" role="note">
          This is a read-only snapshot. Profile editing is unavailable in this build.
        </p>
      ) : null}

      <details className="self-profile__provenance">
        <summary>Account and directory details</summary>
        <p className="self-profile__hint">
          How this account is sourced and kept in sync. Your name, username, and role above are
          the parts you and your teammates see; nothing here identifies you inside the directory.
        </p>
        <dl className="self-profile__facts">
          <div>
            <dt>Profile source</dt>
            <dd>{PROVENANCE_LABELS[saved.provenance]}</dd>
          </div>
          <div>
            <dt>Directory account</dt>
            <dd>{directoryLinkLabel(saved)}</dd>
          </div>
          <div>
            <dt>Directory sync</dt>
            <dd>
              {SYNC_LABELS[saved.directorySyncStatus]}
              {saved.directorySyncedAt
                ? ` · last attempt ${formatTimestamp(saved.directorySyncedAt)}`
                : ""}
            </dd>
          </div>
          <div>
            <dt>Current revision</dt>
            <dd>
              {saved.revision}
              <span className="self-profile__hint">
                {" "}Used when saving so two overlapping edits cannot silently overwrite each other.
              </span>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatTimestamp(saved.updatedAt)}</dd>
          </div>
          <div>
            <dt>Last signed in</dt>
            <dd>{formatTimestamp(saved.lastSeenAt)}</dd>
          </div>
          {saved.avatar ? (
            <div>
              <dt>Avatar on file</dt>
              <dd>{formatAvatar(saved.avatar, "None")}</dd>
            </div>
          ) : null}
        </dl>
      </details>

      {formError ? (
        <p
          className="self-profile__message self-profile__message--error"
          role="alert"
          tabIndex={-1}
          ref={errorRef}
        >
          {formError}
        </p>
      ) : null}
      {notice ? (
        <p className="self-profile__message" role="status" ref={statusRef}>
          {notice}
        </p>
      ) : null}

      {stale ? (
        <div className="self-profile__stale" role="region" aria-label="Saved profile changed">
          <p>
            A newer saved profile is available. Your unsaved edits are still in the form.
            Reload the saved profile, or review the saved values and save again.
          </p>
          <div className="self-profile__actions">
            <button type="button" onClick={() => void reloadSaved()}>
              Reload saved profile
            </button>
            <button type="button" aria-expanded={reviewOpen} onClick={() => setReviewOpen((current) => !current)}>
              {reviewOpen ? "Hide saved values" : "Review saved values"}
            </button>
          </div>
          {reviewOpen ? (
            <table className="self-profile__review">
              <caption>Your edits compared with the profile saved now</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Saved now</th>
                  <th scope="col">Your edit</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(FIELD_LABELS) as SelfEditableField[])
                  .filter((field) => fieldEditable(field, saved.provenance))
                  .map((field) => (
                    <tr key={field}>
                      <th scope="row">{FIELD_LABELS[field]}</th>
                      <td>{reviewValue(stale, field)}</td>
                      <td>{reviewDraftValue(draft, field)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <form className="self-profile__form" onSubmit={onSubmit} noValidate>
        <ProfileTextField
          id={`${formId}-displayName`}
          label="Display name"
          value={draft.displayName}
          maxLength={PROFILE_DISPLAY_NAME_MAX}
          required={localAccount}
          editable={fieldEditable("displayName", saved.provenance) && !editingBlocked}
          directoryOwned={directoryOwned("displayName", saved.provenance)}
          error={fieldError("displayName") ?? null}
          describedBy={describedBy("displayName") ?? null}
          onChange={(value) => updateDraft("displayName", value)}
        />
        <ProfileTextField
          id={`${formId}-roleTitle`}
          label="Role title"
          value={draft.roleTitle}
          maxLength={PROFILE_ROLE_TITLE_MAX}
          editable={fieldEditable("roleTitle", saved.provenance) && !editingBlocked}
          directoryOwned={directoryOwned("roleTitle", saved.provenance)}
          error={fieldError("roleTitle") ?? null}
          describedBy={describedBy("roleTitle") ?? null}
          onChange={(value) => updateDraft("roleTitle", value)}
        />
        <ProfileTextField
          id={`${formId}-team`}
          label="Team"
          value={draft.team}
          maxLength={PROFILE_TEAM_MAX}
          editable={fieldEditable("team", saved.provenance) && !editingBlocked}
          directoryOwned={directoryOwned("team", saved.provenance)}
          error={fieldError("team") ?? null}
          describedBy={describedBy("team") ?? null}
          onChange={(value) => updateDraft("team", value)}
        />
        <ProfileTextField
          id={`${formId}-contactEmail`}
          label="Work email"
          value={draft.contactEmail}
          maxLength={PROFILE_CONTACT_EMAIL_MAX}
          inputMode="email"
          autoComplete="email"
          editable={fieldEditable("contactEmail", saved.provenance) && !editingBlocked}
          directoryOwned={directoryOwned("contactEmail", saved.provenance)}
          error={fieldError("contactEmail") ?? null}
          describedBy={describedBy("contactEmail") ?? null}
          onChange={(value) => updateDraft("contactEmail", value)}
        />
        <ProfileTextField
          id={`${formId}-contactOther`}
          label="Other contact"
          value={draft.contactOther}
          maxLength={PROFILE_CONTACT_OTHER_MAX}
          hint="Pager, chat handle, or another local note. Never stored in the directory."
          editable={fieldEditable("contactOther", saved.provenance) && !editingBlocked}
          directoryOwned={false}
          error={fieldError("contactOther") ?? null}
          describedBy={describedBy("contactOther", `${formId}-contactOther-hint`) ?? null}
          onChange={(value) => updateDraft("contactOther", value)}
        />

        <fieldset className="self-profile__fieldset" disabled={!fieldEditable("avatar", saved.provenance) || editingBlocked}>
          <legend>Avatar</legend>
          <p className="self-profile__hint" id={`${formId}-avatar-hint`}>
            Optional. Initials stay in this workspace. An image must be an https address; this page shows the address, not a remote picture.
          </p>
          <div className="self-profile__radios">
            {([
              ["none", "No avatar"],
              ["initials", "Initials"],
              ["url", "Image address"],
            ] as const).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${formId}-avatar-kind`}
                  value={value}
                  checked={draft.avatarKind === value}
                  onChange={() => updateDraft("avatarKind", value)}
                />
                {label}
              </label>
            ))}
          </div>
          {draft.avatarKind === "initials" ? (
            <label className="self-profile__field">
              Initials
              <input
                value={draft.avatarValue}
                maxLength={4}
                aria-invalid={Boolean(fieldError("avatar"))}
                aria-describedby={describedBy("avatar", `${formId}-avatar-hint`)}
                onChange={(event) => updateDraft("avatarValue", event.target.value)}
              />
            </label>
          ) : null}
          {draft.avatarKind === "url" ? (
            <label className="self-profile__field">
              Image address
              <input
                value={draft.avatarValue}
                maxLength={AVATAR_VALUE_MAX}
                inputMode="url"
                aria-invalid={Boolean(fieldError("avatar"))}
                aria-describedby={describedBy("avatar", `${formId}-avatar-hint`)}
                onChange={(event) => updateDraft("avatarValue", event.target.value)}
              />
            </label>
          ) : null}
          {fieldError("avatar") ? (
            <p className="self-profile__field-error" id={`${formId}-avatar-error`}>
              {fieldError("avatar")}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="self-profile__fieldset" disabled={!fieldEditable("customAttributes", saved.provenance) || editingBlocked}>
          <legend>Custom fields</legend>
          <p className="self-profile__hint" id={`${formId}-custom-hint`}>
            Up to {PROFILE_CUSTOM_ATTR_MAX_COUNT} local labels. Names use letters, digits, _ or -. These never update LDAP or your sign-in provider.
          </p>
          <ul className="self-profile__attrs">
            {draft.customAttributes.map((attribute, index) => (
              <li key={`custom-field-${index}`}>
                <label>
                  Name
                  <input
                    value={attribute.key}
                    maxLength={64}
                    aria-describedby={`${formId}-custom-hint`}
                    onChange={(event) => {
                      const next = [...draft.customAttributes];
                      next[index] = { key: event.target.value, value: attribute.value };
                      updateDraft("customAttributes", next);
                    }}
                  />
                </label>
                <label>
                  Value
                  <input
                    value={attribute.value}
                    maxLength={PROFILE_CUSTOM_ATTR_VALUE_MAX}
                    onChange={(event) => {
                      const next = [...draft.customAttributes];
                      next[index] = { key: attribute.key, value: event.target.value };
                      updateDraft("customAttributes", next);
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="profile-button profile-button--quiet"
                  onClick={() => {
                    updateDraft(
                      "customAttributes",
                      draft.customAttributes.filter((_, item) => item !== index),
                    );
                  }}
                >
                  Remove {attribute.key || "field"}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={draft.customAttributes.length >= PROFILE_CUSTOM_ATTR_MAX_COUNT}
            onClick={() => {
              if (draft.customAttributes.length >= PROFILE_CUSTOM_ATTR_MAX_COUNT) return;
              updateDraft("customAttributes", [...draft.customAttributes, { key: "", value: "" }]);
            }}
          >
            Add a custom field
          </button>
          {fieldError("customAttributes") ? (
            <p className="self-profile__field-error" id={`${formId}-customAttributes-error`}>
              {fieldError("customAttributes")}
            </p>
          ) : null}
        </fieldset>

        <p className="self-profile__attribution" role="note">
          Save updates how you appear from now on. Historical authored records stay as they were written.
        </p>

        <div className="self-profile__actions">
          <button ref={saveRef} className="profile-button profile-button--primary" type="submit" disabled={!canSave || !anyEditable}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button type="button" disabled={!dirty || saving} onClick={cancelEdits}>
            Cancel
          </button>
        </div>
      </form>

      {directoryAccount ? (
        <p className="self-profile__footnote" role="note">
          Directory-owned fields stay visible so you can recognize your account. Editing them here would not, and does not, change LDAP or the sign-in provider.
        </p>
      ) : null}

      {props.leaveRequest ? (
        <LeaveDialog onCancel={props.onLeaveCancel} onConfirm={props.onLeaveConfirm} />
      ) : null}
    </section>
  );
}

function reviewValue(profile: UserProfileV1, field: SelfEditableField): string {
  if (field === "avatar") return formatAvatar(profile.avatar, "None");
  if (field === "customAttributes") {
    return profile.customAttributes.length === 0
      ? "None"
      : profile.customAttributes.map((attribute) => `${attribute.key}: ${attribute.value}`).join(", ");
  }
  const value = profile[field];
  return value && value.trim() !== "" ? value : "Blank";
}

function reviewDraftValue(draft: Draft, field: SelfEditableField): string {
  if (field === "avatar") return formatAvatar(avatarPayload(draft), "None");
  if (field === "customAttributes") {
    const attributes = compactAttributes(draft.customAttributes);
    return attributes.length === 0
      ? "None"
      : attributes.map((attribute) => `${attribute.key}: ${attribute.value}`).join(", ");
  }
  const value = draft[field];
  return value.trim() === "" ? "Blank" : value;
}

function ProfileTextField(props: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  editable: boolean;
  directoryOwned: boolean;
  error: string | null;
  describedBy: string | null;
  hint?: string;
  required?: boolean;
  inputMode?: "email";
  autoComplete?: string;
  onChange: (value: string) => void;
}) {
  const hintId = props.hint ? `${props.id}-hint` : undefined;
  const errorId = props.error ? `${props.id}-error` : undefined;
  const describedBy = [props.describedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="self-profile__field">
      <label htmlFor={props.id}>
        {props.label}
        {props.directoryOwned ? <span className="self-profile__badge">Directory-owned</span> : null}
      </label>
      {props.editable ? (
        <input
          id={props.id}
          value={props.value}
          maxLength={props.maxLength}
          required={props.required === true}
          {...(props.inputMode ? { inputMode: props.inputMode } : {})}
          {...(props.autoComplete ? { autoComplete: props.autoComplete } : {})}
          aria-invalid={Boolean(props.error)}
          {...(describedBy ? { "aria-describedby": describedBy } : {})}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <p className="self-profile__readonly" id={props.id}>
          {props.value.trim() === "" ? "Not recorded" : props.value}
        </p>
      )}
      {props.hint ? <p className="self-profile__hint" id={hintId}>{props.hint}</p> : null}
      {props.directoryOwned ? (
        <p className="self-profile__hint">
          Owned by the directory. This page cannot change LDAP or your sign-in provider.
        </p>
      ) : null}
      {props.error ? (
        <p className="self-profile__field-error" id={errorId}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}
