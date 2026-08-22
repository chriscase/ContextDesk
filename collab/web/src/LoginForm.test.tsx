import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./LoginForm.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type MockResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

function respond(status: number, body: unknown): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Every failure code below is one `POST /api/auth/login` really returns. */
function stubLogin(res: MockResponse | (() => Promise<MockResponse>)) {
  const fetchMock = vi.fn(async () => (typeof res === "function" ? res() : res));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fillAndSubmit(username = "alice", password = "fixture-alice-secret") {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("login form", () => {
  it("posts the entered credentials to the auth route and reports success", async () => {
    const fetchMock = stubLogin(respond(200, {}));
    const onSuccess = vi.fn();
    render(<LoginForm onSuccess={onSuccess} />);
    fillAndSubmit();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      username: "alice",
      password: "fixture-alice-secret",
    });
    // Credentials must not linger in the DOM once the session exists.
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("names a credential mismatch and sends the operator back to the username", async () => {
    stubLogin(respond(401, { error: "invalid_credentials" }));
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit("alice", "wrong");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That username and password did not match.");
    expect(alert.textContent).toContain("Check both values and enter them again.");
    const username = screen.getByLabelText("Username");
    expect(document.activeElement).toBe(username);
    expect(username.getAttribute("aria-invalid")).toBe("true");
    // Re-sending the same rejected credentials is not a retry.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("distinguishes an unmapped role from a bad password", async () => {
    stubLogin(respond(403, { error: "access_denied" }));
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no workspace role is mapped to this account");
    expect(alert.textContent).toContain("An administrator has to grant a role");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry only when waiting could actually help", async () => {
    const fetchMock = stubLogin(respond(429, { error: "rate_limited" }));
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Too many sign-in attempts from this address.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The retry re-reads the live fields rather than replaying a stored copy.
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      username: "alice",
      password: "fixture-alice-secret",
    });
  });

  it("surfaces a transport failure instead of going quiet", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn();
    render(<LoginForm onSuccess={onSuccess} />);
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The sign-in service could not be reached.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("reports an unrecognised failure by status rather than inventing a reason", async () => {
    stubLogin({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    });
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The server returned HTTP 500");
    expect(alert.textContent).toContain("no reason this form recognises");
    expect(alert.textContent).not.toContain("password");
  });

  it("marks the form busy and holds the fields steady while the request is open", async () => {
    let release: (value: MockResponse) => void = () => {};
    const gate = new Promise<MockResponse>((resolve) => {
      release = resolve;
    });
    stubLogin(() => gate);
    const { container } = render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit();

    const form = container.querySelector("form.login");
    await waitFor(() => expect(form?.getAttribute("aria-busy")).toBe("true"));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Signing in…");
    // readOnly, not disabled: focus and tab order survive the round trip.
    expect((screen.getByLabelText("Password") as HTMLInputElement).readOnly).toBe(true);

    release(respond(200, {}));
    await waitFor(() => expect(form?.getAttribute("aria-busy")).toBe("false"));
  });

  it("sends one request when the form is submitted twice in a row", async () => {
    let release: (value: MockResponse) => void = () => {};
    const gate = new Promise<MockResponse>((resolve) => {
      release = resolve;
    });
    const fetchMock = stubLogin(() => gate);
    const { container } = render(<LoginForm onSuccess={vi.fn()} />);
    const form = container.querySelector("form.login") as HTMLFormElement;
    fillAndSubmit();
    // Enter inside a field submits even while the button is disabled.
    fireEvent.submit(form);

    release(respond(200, {}));
    await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("wires the failure text to both fields for assistive technology", async () => {
    stubLogin(respond(401, { error: "invalid_credentials" }));
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit("alice", "wrong");

    const alert = await screen.findByRole("alert");
    const describedBy = screen.getByLabelText("Username").getAttribute("aria-describedby");
    expect(describedBy).toBe(alert.id);
    expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe(alert.id);
  });

  // collab/e2e/specs/01-local-auth-login.spec.ts asserts getByText("Sign-in
  // failed.") for both the 401 and 403 paths. Pin it here so a copy change
  // cannot break the browser suite without failing this suite first.
  it.each([
    ["invalid_credentials", 401],
    ["access_denied", 403],
    ["rate_limited", 429],
  ])("headlines the %s failure as a failed sign-in", async (code, status) => {
    stubLogin(respond(status, { error: code }));
    render(<LoginForm onSuccess={vi.fn()} />);
    fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert.querySelector(".login__error-headline")?.textContent).toBe("Sign-in failed.");
  });

  it("keeps honouring seeded demo credentials", () => {
    stubLogin(respond(200, {}));
    render(
      <LoginForm onSuccess={vi.fn()} defaults={{ username: "demo", password: "demo" }} />,
    );
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("demo");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("demo");
  });
});
