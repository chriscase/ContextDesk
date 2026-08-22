import { useId, useRef, useState, type FormEvent } from "react";

/**
 * What the operator is told after a failed sign-in.
 *
 * `reason` is why it failed and `hint` is what to do next, kept apart so the
 * two stay distinguishable; `retryable` decides whether re-sending the same
 * credentials could plausibly succeed.
 */
type Failure = {
  reason: string;
  hint: string;
  retryable: boolean;
  refocus: boolean;
};

/**
 * Every failure below is a failure to sign in: the server denies a role
 * mapping before it creates a session, so no path here leaves the operator
 * holding one. Stating that once, up front, keeps the specific reasons from
 * having to each re-establish it.
 */
const HEADLINE = "Sign-in failed.";

/**
 * Only the codes `POST /api/auth/login` actually returns
 * (`collab/server/src/modules/auth/routes.ts`: 401 invalid_credentials,
 * 403 access_denied, 429 rate_limited). Anything else is reported by status
 * code instead of guessed at, so the form never tells an operator more about
 * the failure than the server actually said.
 */
const AUTH_FAILURES: Record<string, Failure> = {
  invalid_credentials: {
    reason: "That username and password did not match.",
    hint: "Check both values and enter them again.",
    retryable: false,
    refocus: true,
  },
  access_denied: {
    reason: "Your credentials were accepted, but no workspace role is mapped to this account.",
    hint: "An administrator has to grant a role before the workspace opens.",
    retryable: false,
    refocus: false,
  },
  rate_limited: {
    reason: "Too many sign-in attempts from this address.",
    hint: "Wait a moment, then try again.",
    retryable: true,
    refocus: false,
  },
};

const UNREACHABLE: Failure = {
  reason: "The sign-in service could not be reached.",
  hint: "Check the connection to the workspace server, then try again.",
  retryable: true,
  refocus: false,
};

function failureFor(status: number, code: string | null): Failure {
  const known = code === null ? undefined : AUTH_FAILURES[code];
  if (known) return known;
  return {
    reason: `The server returned HTTP ${status} with no reason this form recognises.`,
    hint: "Trying again is safe.",
    retryable: true,
    refocus: false,
  };
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const code = (body as { error: unknown }).error;
      if (typeof code === "string") return code;
    }
  } catch {
    // A non-JSON error body is unremarkable; fall back to the status code.
  }
  return null;
}

export function LoginForm(props: {
  onSuccess: () => void;
  defaults?: { username: string; password: string };
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  // Enter inside a field submits the form even while the button is disabled,
  // so the guard has to be a ref: `pending` has not flushed yet at that point.
  const inFlight = useRef(false);
  const errorId = useId();
  const statusId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const username = String(data.get("username") ?? "");
    const password = String(data.get("password") ?? "");
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const next = failureFor(res.status, await readErrorCode(res));
        setFailure(next);
        if (next.refocus) usernameRef.current?.focus();
        return;
      }
      form.reset();
      props.onSuccess();
    } catch {
      // fetch rejects on transport failure. Without this the rejection was
      // unhandled and the operator just saw the form go quiet.
      setFailure(UNREACHABLE);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="login"
      ref={formRef}
      onSubmit={(e) => void onSubmit(e)}
      aria-busy={pending}
    >
      <label className="login__label">
        Username
        <input
          className="login__input"
          ref={usernameRef}
          name="username"
          autoComplete="username"
          defaultValue={props.defaults?.username}
          aria-describedby={failure ? errorId : undefined}
          aria-invalid={failure?.refocus ? true : undefined}
          readOnly={pending}
          required
        />
      </label>
      <label className="login__label">
        Password
        <input
          className="login__input"
          name="password"
          type="password"
          autoComplete="current-password"
          defaultValue={props.defaults?.password}
          aria-describedby={failure ? errorId : undefined}
          readOnly={pending}
          required
        />
      </label>
      {failure ? (
        <p className="login__error" id={errorId} role="alert">
          <strong className="login__error-headline">{HEADLINE}</strong>
          <span className="login__reason">{failure.reason}</span>
          <span className="login__hint">{failure.hint}</span>
        </p>
      ) : null}
      <div className="login__actions">
        <button className="login__submit" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {failure?.retryable ? (
          // Re-submits the live form rather than replaying a stored copy, so
          // the password is never held anywhere outside the password field.
          <button
            className="login__retry"
            type="button"
            onClick={() => formRef.current?.requestSubmit()}
            disabled={pending}
          >
            Try again
          </button>
        ) : null}
      </div>
      <p className="login__status" id={statusId} role="status" aria-live="polite">
        {pending ? "Signing in…" : ""}
      </p>
    </form>
  );
}
