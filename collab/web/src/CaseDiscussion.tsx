import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { ContributionView } from "./TriageWorkspace.js";
import type { WorkFocus } from "./app-location.js";
import { protectedApiFetch } from "./protected-api.js";
import { useRouteFocus } from "./route-focus.js";

interface PresenceMemberView {
  identityId: string;
  username: string;
  surface: string;
  lastSeenAt: string;
}

/** Matches the presence cadence the Help Center documents for other surfaces. */
const DEFAULT_POLL_MS = 15_000;

function messageWhen(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function privacyLabel(privacyClass: string): string {
  if (privacyClass === "share_safe") return "share-safe";
  if (privacyClass === "owner_only") return "private to the case";
  return privacyClass;
}

/**
 * The discussion thread is exactly the durable, non-tombstoned human `message`
 * contributions on the case. Notes, hypotheses, uploads, and mirrored
 * `external_run` output belong to the Capture record, never to this thread.
 * The wire order is by contribution id, so the thread re-sorts by recorded
 * time; entries without a recorded time keep wire order at the end.
 */
function threadOf(rows: ContributionView[]): ContributionView[] {
  return rows
    .filter((row) => row.kind === "message" && !row.tombstoned && row.body !== null)
    .sort((a, b) => {
      if (a.createdAt && b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      }
      if (a.createdAt) return -1;
      if (b.createdAt) return 1;
      return 0;
    });
}

/**
 * A persistent side panel over the shipped case contribution and presence
 * APIs. It refreshes by bounded polling while open — live refresh, not
 * realtime chat — and posts messages through the existing contributions
 * endpoint so every message is a durable, attributed case contribution.
 */
export function CaseDiscussion(props: {
  caseId: string;
  participant?: { username: string; roles: string[] };
  canWrite: boolean;
  readOnly: boolean;
  onClose: () => void;
  onPosted?: () => void;
  onPresence?: (count: number | null) => void;
  pollIntervalMs?: number;
  routeFocus?: WorkFocus;
}) {
  const [messages, setMessages] = useState<ContributionView[] | null>(null);
  const [threadError, setThreadError] = useState(false);
  const [presenceMembers, setPresenceMembers] = useState<PresenceMemberView[] | null>(null);
  const [presenceFailed, setPresenceFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [privacyClass, setPrivacyClass] = useState<"owner_only" | "share_safe">("owner_only");
  const [postState, setPostState] = useState<"idle" | "pending" | "saved" | "failed">("idle");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [renderedCase, setRenderedCase] = useState(props.caseId);
  const panelRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  const liveGeneration = useRef(0);
  // Monotonic per-resource sequence: only the most recently issued request may
  // apply, so an older in-flight response can never overwrite a newer one.
  const threadReq = useRef(0);
  const presenceReq = useRef(0);
  const caseIdRef = useRef(props.caseId);
  const onPresenceRef = useRef(props.onPresence);
  useRouteFocus(props.routeFocus, messages !== null);

  // Reset at the case boundary during render, before anything is committed,
  // so a prior case's thread can never be shown against the new case — even
  // for one frame, and even when the parent does not remount by key.
  caseIdRef.current = props.caseId;
  if (renderedCase !== props.caseId) {
    setRenderedCase(props.caseId);
    setMessages(null);
    setThreadError(false);
    setPresenceMembers(null);
    setPresenceFailed(false);
    setDraft("");
    setPostState("idle");
    setConfirmingDiscard(false);
    setCloseBlocked(false);
  }

  useEffect(() => {
    onPresenceRef.current = props.onPresence;
  });

  const refreshThread = useCallback(
    async (alive: () => boolean) => {
      const caseId = props.caseId;
      const seq = ++threadReq.current;
      const fresh = () =>
        alive() && seq === threadReq.current && caseId === caseIdRef.current;
      const response = await protectedApiFetch(`/api/cases/${caseId}/contributions`).catch(() => null);
      if (!fresh()) return;
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as {
            contributions?: ContributionView[];
          } | null)
        : null;
      if (!fresh()) return;
      if (!body || !Array.isArray(body.contributions)) {
        setThreadError(true);
        return;
      }
      setThreadError(false);
      setMessages(threadOf(body.contributions));
    },
    [props.caseId],
  );

  const refreshPresence = useCallback(
    async (alive: () => boolean) => {
      // Read-only: the panel never announces a presence surface of its own —
      // it only reports the members the shipped presence API already records.
      const caseId = props.caseId;
      const seq = ++presenceReq.current;
      const fresh = () =>
        alive() && seq === presenceReq.current && caseId === caseIdRef.current;
      const response = await protectedApiFetch(`/api/cases/${caseId}/presence`).catch(() => null);
      if (!fresh()) return;
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as {
            members?: PresenceMemberView[];
          } | null)
        : null;
      if (!fresh()) return;
      if (!body || !Array.isArray(body.members)) {
        setPresenceMembers(null);
        setPresenceFailed(true);
        onPresenceRef.current?.(null);
        return;
      }
      setPresenceMembers(body.members);
      setPresenceFailed(false);
      onPresenceRef.current?.(body.members.length);
    },
    [props.caseId],
  );

  useEffect(() => {
    const generation = ++liveGeneration.current;
    const alive = () => generation === liveGeneration.current;
    const tick = () => {
      void refreshThread(alive);
      void refreshPresence(alive);
    };
    tick();
    const timer = window.setInterval(tick, props.pollIntervalMs ?? DEFAULT_POLL_MS);
    return () => {
      liveGeneration.current += 1;
      window.clearInterval(timer);
    };
  }, [refreshThread, refreshPresence, props.pollIntervalMs]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (confirmingDiscard) keepEditingRef.current?.focus();
  }, [confirmingDiscard]);

  /**
   * The one close path for Escape and the Close button. Closing is refused
   * while a post is saving, and a dirty draft demands an explicit inline
   * discard decision — it is never silently thrown away. `props.onClose`
   * (and with it the caller's focus return) runs only on an actual close.
   */
  function requestClose() {
    if (postState === "pending") {
      setCloseBlocked(true);
      return;
    }
    if (draft.trim()) {
      setConfirmingDiscard(true);
      return;
    }
    props.onClose();
  }

  function keepEditing() {
    setConfirmingDiscard(false);
    composerRef.current?.focus();
  }

  function discardAndClose() {
    setConfirmingDiscard(false);
    setDraft("");
    props.onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (confirmingDiscard) {
      keepEditing();
      return;
    }
    requestClose();
  }

  /** Any edit after a saved/failed outcome is a new, unsaved draft. */
  function editDraft(value: string) {
    setDraft(value);
    if (postState === "saved" || postState === "failed") setPostState("idle");
  }

  function editPrivacy(value: string) {
    setPrivacyClass(value === "share_safe" ? "share_safe" : "owner_only");
    if (postState === "saved" || postState === "failed") setPostState("idle");
  }

  async function postMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || postState === "pending") return;
    setPostState("pending");
    setCloseBlocked(false);
    setConfirmingDiscard(false);
    try {
      const response = await protectedApiFetch(`/api/cases/${props.caseId}/contributions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "message", body, privacyClass }),
      });
      if (!response.ok) {
        setPostState("failed");
        return;
      }
      setDraft("");
      setPostState("saved");
      const generation = liveGeneration.current;
      await refreshThread(() => generation === liveGeneration.current);
      props.onPosted?.();
    } catch {
      setPostState("failed");
    }
  }

  // Identity is already visible in the persistent account control. Repeating
  // the username and roles here adds noise without helping the operator
  // understand this surface; keep the local context about attribution instead.
  const discussionContext = props.readOnly
    ? "Static read-only view"
    : props.canWrite
      ? "Messages are attributed to your account"
      : "Authenticated case discussion";

  return (
    <aside
      id="case-discussion"
      className="discussion"
      aria-labelledby="case-discussion-title"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={handleKeyDown}
    >
      <header className="discussion__head">
        <div className="discussion__head-copy">
          <h3 id="case-discussion-title" className="discussion__title">
            Discussion
          </h3>
          <p className="discussion__context">{discussionContext}</p>
        </div>
        <button type="button" className="discussion__close" onClick={requestClose}>
          Close discussion
        </button>
      </header>
      {postState === "pending" && closeBlocked ? (
        <p className="discussion__notice" role="status">
          Still saving your message — the panel stays open until it finishes.
        </p>
      ) : null}
      {confirmingDiscard ? (
        <div
          className="discussion__discard"
          role="group"
          aria-labelledby="discussion-discard-title"
        >
          <p id="discussion-discard-title" className="discussion__discard-copy">
            Your draft message has not been posted. Discard it and close the discussion?
          </p>
          <div className="discussion__discard-actions">
            <button
              type="button"
              className="discussion__discard-keep"
              ref={keepEditingRef}
              onClick={keepEditing}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="discussion__discard-confirm"
              onClick={discardAndClose}
            >
              Discard draft
            </button>
          </div>
        </div>
      ) : null}
      <p className="discussion__presence" role="status">
        {presenceMembers
          ? `${presenceMembers.length} active on this case now`
          : presenceFailed
            ? "Presence unavailable right now"
            : "Checking who is active…"}
        {" · live refresh by polling"}
      </p>
      <p className="discussion__note">
        Messages are durable case contributions attributed to their author. Presence is an
        ephemeral coordination signal — never case evidence. This panel refreshes by polling; it
        is not realtime chat.
      </p>
      <div className="discussion__thread">
        <p className="discussion__count" role="status">
          {messages === null
            ? "Loading the discussion…"
            : `${messages.length} recorded message${messages.length === 1 ? "" : "s"}`}
        </p>
        {threadError ? (
          <p className="case-memory__error" role="alert">
            The discussion could not be refreshed. Showing the last loaded state.
          </p>
        ) : null}
        {messages !== null && messages.length === 0 ? (
          <p className="discussion__empty">
            No discussion messages yet.
            {props.canWrite ? " Start the thread below — messages land on the case record." : ""}
          </p>
        ) : null}
        {messages !== null && messages.length > 0 ? (
          // The scroll container is itself keyboard-focusable so the thread
          // can be scrolled without a pointer, and it is the named landmark
          // for the message list.
          <div
            className="discussion__scroll"
            role="region"
            aria-label="Discussion messages"
            tabIndex={0}
          >
          <ol className="discussion__messages">
            {messages.map((message) => {
              const when = messageWhen(message.createdAt);
              return (
                <li
                  key={message.id}
                  className="discussion__message"
                  data-route-item={message.id}
                  data-route-kind="comment"
                  tabIndex={-1}
                >
                  <p className="discussion__message-meta">
                    <strong className="discussion__author">
                      {message.authorUsername ?? "Author not recorded"}
                    </strong>
                    {when ? <span className="discussion__when">{when}</span> : null}
                    <span
                      className={`discussion__privacy${
                        message.privacyClass === "share_safe" ? " discussion__privacy--share" : ""
                      }`}
                    >
                      {privacyLabel(message.privacyClass)}
                    </span>
                  </p>
                  <p className="discussion__message-body">{message.body}</p>
                </li>
              );
            })}
          </ol>
          </div>
        ) : null}
      </div>
      {props.canWrite ? (
        <form
          className="discussion__composer"
          aria-label="Post a discussion message"
          onSubmit={(e) => void postMessage(e)}
        >
          <label className="triage-field">
            Message
            <textarea
              className="login__input"
              ref={composerRef}
              value={draft}
              onChange={(e) => editDraft(e.target.value)}
              rows={3}
              required
              placeholder="Share what the team should know"
            />
          </label>
          <label className="triage-field">
            Message visibility
            <select
              className="login__input"
              value={privacyClass}
              onChange={(e) => editPrivacy(e.target.value)}
            >
              <option value="owner_only">Private to the case</option>
              <option value="share_safe">Eligible for share-safe export</option>
            </select>
          </label>
          <button className="login__submit" type="submit" disabled={postState === "pending"}>
            {postState === "pending" ? "Posting…" : "Post to discussion"}
          </button>
          {postState === "pending" ? (
            <p className="discussion__pending" role="status">
              Saving your message to the case record…
            </p>
          ) : null}
          {postState === "failed" ? (
            <p className="case-memory__error" role="alert">
              The message was not saved. Your draft is still in the composer — try posting again.
            </p>
          ) : null}
          {postState === "saved" ? (
            <p className="discussion__saved" role="status">
              Message saved to the case record.
            </p>
          ) : null}
        </form>
      ) : props.readOnly ? (
        <p className="discussion__notice" role="status">
          Static read-only view: the discussion record is browsable, but posting is unavailable.
        </p>
      ) : (
        <p className="discussion__notice" role="status">
          Your current role can read the discussion but not post. Ask a case lead for contributor
          access.
        </p>
      )}
    </aside>
  );
}
