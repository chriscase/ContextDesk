import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpCenter } from "./HelpCenter.js";

afterEach(() => {
  cleanup();
});

function renderHelp(overrides?: {
  onOpenArea?: ReturnType<typeof vi.fn>;
  onOpenStage?: ReturnType<typeof vi.fn> | null;
}) {
  const onOpenArea = overrides?.onOpenArea ?? vi.fn();
  const onOpenStage = overrides?.onOpenStage === undefined ? null : overrides.onOpenStage;
  render(<HelpCenter onOpenArea={onOpenArea} onOpenStage={onOpenStage} />);
  return { onOpenArea, onOpenStage };
}

function searchFor(value: string) {
  fireEvent.change(screen.getByLabelText("Search help"), { target: { value } });
}

function resultsList(): HTMLElement {
  return screen.getByRole("list", { name: "Search results" });
}

describe("help landing", () => {
  it("shows the searchable landing with orientation, quick tasks, and the flow graphic", () => {
    renderHelp();
    expect(screen.getByRole("heading", { name: "Help Center" })).toBeTruthy();
    expect(screen.getByRole("search")).toBeTruthy();
    expect(screen.getByLabelText("Search help")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What are you trying to do?" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Walk through a fresh investigation/ }),
    ).toBeTruthy();
    const flow = screen.getByRole("list", { name: "Capture to Decide flow" });
    const steps = within(flow).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      "Captureevidence in, with provenance",
      "Analyzesnapshots & AI lanes",
      "Comparelanes on the same evidence",
      "Decidea person makes the call",
    ]);
  });

  it("lists every topic category and the glossary in the topic rail", () => {
    renderHelp();
    const rail = screen.getByRole("navigation", { name: "Help topics" });
    for (const category of [
      "Get started",
      "Capture & provenance",
      "Analyze & triage runs",
      "Compare models & evidence fairness",
      "Decide & share-safe export",
      "Investigation Teams & qualification",
      "Attribution",
      "Collaboration & presence",
      "Privacy & administration",
    ]) {
      expect(within(rail).getByRole("heading", { name: category })).toBeTruthy();
    }
    expect(within(rail).getByRole("button", { name: "Glossary" })).toBeTruthy();
  });

  it("does not render every article body at once", () => {
    renderHelp();
    expect(screen.queryByRole("heading", { name: "What this is" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Limits" })).toBeNull();
  });

  it("opens the complete first-investigation walkthrough", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /Walk through a fresh investigation/ }));
    expect(
      screen.getByRole("heading", { name: "Complete your first investigation" }),
    ).toBeTruthy();
    expect(screen.getByText(/Open Investigations and select Start investigation/)).toBeTruthy();
    expect(screen.getByText(/Review the intake preview before committing it/)).toBeTruthy();
    expect(screen.getByText(/record the human conclusion with its reason/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start from Investigations" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "See the path" })).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(
      screen.getByRole("img", {
        name: "Investigations page with the Start Investigation button and sample cases",
      }),
    ).toBeTruthy();
  });

  it("opens a screenshot at full size and closes with Escape", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: /Walk through a fresh investigation/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand screenshot: Start with an investigation and give it a specific title." }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("help search", () => {
  it("ranks a title match above body-only matches and announces the count", () => {
    renderHelp();
    searchFor("import");
    expect(screen.getByRole("status").textContent).toMatch(/^\d+ results? for “import”$/);
    const results = within(resultsList()).getAllByRole("button");
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]?.querySelector(".help-result__title")?.textContent).toBe(
      "Import output from an outside tool",
    );
  });

  it("shows matched context with the term highlighted", () => {
    renderHelp();
    searchFor("fingerprint");
    const snippetMark = resultsList().querySelector(".help-result__snippet mark");
    expect(snippetMark?.textContent?.toLowerCase()).toBe("fingerprint");
  });

  it("clears the search and returns to the landing view", () => {
    renderHelp();
    searchFor("snapshot");
    expect(screen.queryByRole("heading", { name: "What are you trying to do?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByLabelText("Search help") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("heading", { name: "What are you trying to do?" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("answers \"can I delete this?\" with the archive topic", () => {
    // The question people actually ask is about deletion; the answer the
    // product has is archiving. Search has to bridge the two words, or the
    // honest answer stays unfindable.
    renderHelp();
    searchFor("delete");
    const titles = within(resultsList())
      .getAllByRole("button")
      .map((result) => result.querySelector(".help-result__title")?.textContent);
    expect(titles).toContain("Archive an investigation, and bring it back");
  });

  it("finds the archive topic by the words people use for it", () => {
    for (const term of ["archive", "unarchive", "hide", "legal hold"]) {
      renderHelp();
      searchFor(term);
      const titles = within(resultsList())
        .getAllByRole("button")
        .map((result) => result.querySelector(".help-result__title")?.textContent);
      expect(titles, `searching “${term}”`).toContain(
        "Archive an investigation, and bring it back",
      );
      cleanup();
    }
  });

  it("states an honest no-results outcome and what search does not cover", () => {
    renderHelp();
    searchFor("zzzunfindable");
    expect(screen.getByRole("status").textContent).toBe("0 results for “zzzunfindable”");
    expect(screen.getByText(/No help articles match/)).toBeTruthy();
    expect(
      screen.getByText(/does not search your investigations or evidence/),
    ).toBeTruthy();
  });

  it("opens an article from a result and clears the query", () => {
    renderHelp();
    searchFor("import");
    const results = within(resultsList()).getAllByRole("button");
    fireEvent.click(results[0] as HTMLElement);
    expect(
      screen.getByRole("heading", { name: "Import output from an outside tool" }),
    ).toBeTruthy();
    expect((screen.getByLabelText("Search help") as HTMLInputElement).value).toBe("");
    for (const section of [
      "What this is",
      "When to use it",
      "Steps",
      "What gets recorded",
      "Limits",
    ]) {
      expect(screen.getByRole("heading", { name: section })).toBeTruthy();
    }
  });

  it("finds file, ZIP, and directory intake with privacy and size limits", () => {
    renderHelp();
    searchFor("idempotency key");
    fireEvent.click(within(resultsList()).getAllByRole("button")[0] as HTMLElement);
    expect(screen.getByText(/Archives are capped at 512 MiB/)).toBeTruthy();
    expect(screen.getByText(/expanded bytes at 512 MiB, 4,096 files/)).toBeTruthy();
    expect(screen.getByText(/512 MiB per file, compression ratio 256, and 60 seconds/)).toBeTruthy();
    expect(screen.getByText(/overflow is rejected, never silently dropped/)).toBeTruthy();
    expect(screen.getByText(/JSONL\/NDJSON/)).toBeTruthy();
    expect(screen.getByText(/structured JSON and JSONL records must parse/)).toBeTruthy();
    expect(screen.getByText(/marking an item share_safe does not scrub/)).toBeTruthy();
    expect(screen.getByText(/qwen-3.6-27b, gpt-oss-120b, and ministral/)).toBeTruthy();
    expect(screen.getByText(/global source catalog is not the path for investigation uploads/)).toBeTruthy();
  });

  it("explains the supported portable restore boundary", () => {
    renderHelp();
    searchFor("restore");
    const result = within(resultsList()).getByRole("button", {
      name: /Move or restore a portable investigation/,
    });
    fireEvent.click(result);
    expect(
      screen.getByText(/current brief and selected-evidence package/, { exact: false }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only fields represented and supported exactly can be restored/, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Ed25519 metadata is recorded, not verified/, { exact: false }),
    ).toBeTruthy();
  });

  it("finds glossary terms and jumps focus to the matched term", () => {
    renderHelp();
    searchFor("qualification");
    const glossaryResult = within(resultsList())
      .getAllByRole("button")
      .find((button) => button.querySelector(".help-result__category")?.textContent === "Glossary");
    expect(glossaryResult).toBeTruthy();
    fireEvent.click(glossaryResult as HTMLElement);
    expect(screen.getByRole("heading", { name: "Glossary" })).toBeTruthy();
    expect(document.activeElement?.id).toBe("help-term-qualification");
  });
});

describe("log workbench help", () => {
  it("teaches file filtering, Find, and match navigation for the workbench", () => {
    renderHelp();
    searchFor("filter files");
    const result = within(resultsList()).getByRole("button", {
      name: /Use the Log workbench/,
    });
    fireEvent.click(result);
    expect(screen.getByRole("heading", { name: "Use the Log workbench" })).toBeTruthy();
    expect(screen.getByText(/Filter files by name or path/)).toBeTruthy();
    expect(screen.getByText(/Previous\/Next, F3, or Ctrl\/Cmd\+G/)).toBeTruthy();
    expect(screen.getByText(/Timezone review is reversible and never guesses a zone/)).toBeTruthy();
  });
});

describe("article selection and mobile back", () => {
  it("selects an article from the rail, marks it current, and hands focus to its title", () => {
    renderHelp();
    const link = screen.getByRole("button", { name: "Freeze an evidence snapshot" });
    fireEvent.click(link);
    const title = screen.getByRole("heading", { name: "Freeze an evidence snapshot" });
    expect(document.activeElement).toBe(title);
    expect(link.getAttribute("aria-current")).toBe("true");
  });

  it("returns to the topic list through the Back to topics control", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Read the case board" }));
    expect(screen.getByRole("heading", { name: "Read the case board" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "What are you trying to do?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to topics" }));
    expect(screen.queryByRole("heading", { name: "Read the case board" })).toBeNull();
    expect(screen.getByRole("heading", { name: "What are you trying to do?" })).toBeTruthy();
  });
});

describe("glossary", () => {
  it("defines every core term, including the required vocabulary", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Glossary" }));
    const terms = screen.getAllByRole("term").map((node) => node.textContent);
    for (const required of [
      "investigation",
      "evidence snapshot",
      "imported run",
      "provenance",
      "lane",
      "accepted decision",
      "share-safe",
      "profile",
      "qualification",
      "host profile",
      "user profile",
    ]) {
      expect(terms).toContain(required);
    }
  });
});

describe("real navigation callbacks", () => {
  it("routes area actions through the bounded callback", () => {
    const { onOpenArea } = renderHelp({ onOpenArea: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Who and what supplied the information" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to Attribution" }));
    expect(onOpenArea).toHaveBeenCalledWith("sources");
  });

  it("renders no stage shortcuts at all without an investigation context", () => {
    renderHelp({ onOpenStage: null });
    expect(screen.queryByRole("group", { name: "Return to your investigation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run AI lanes against a snapshot" }));
    expect(screen.queryByRole("button", { name: "Open the Analyze stage" })).toBeNull();
  });

  it("offers working stage shortcuts when an investigation is in focus", () => {
    const onOpenStage = vi.fn();
    renderHelp({ onOpenStage });
    const shortcuts = screen.getByRole("group", { name: "Return to your investigation" });
    fireEvent.click(within(shortcuts).getByRole("button", { name: "Decide" }));
    expect(onOpenStage).toHaveBeenCalledWith("decide");
    fireEvent.click(screen.getByRole("button", { name: "Run AI lanes against a snapshot" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the Analyze stage" }));
    expect(onOpenStage).toHaveBeenCalledWith("analyze");
  });
});

describe("honest limitation copy", () => {
  it("states that presence is polling, not a real-time chat channel", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "See who is working the case" }));
    expect(screen.getAllByText(/about every 15 seconds/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/HTTP polling, not a real-time connection — there is no live chat channel/),
    ).toBeTruthy();
  });

  it("states that demo sign-in is a fixture account, not the production directory", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Sign in, roles, and what you can do" }));
    expect(screen.getByText(/built-in fixture account/)).toBeTruthy();
    expect(screen.getByText(/LDAP directory by default/)).toBeTruthy();
  });

  it("describes the shipped admin console while keeping setup and qualification limits honest", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Administration and setup" }));
    expect(screen.getByText(/visible only with the admin:users capability/)).toBeTruthy();
    expect(screen.getByText(/finding an identity or group grants nothing/)).toBeTruthy();
    expect(screen.getByText(/never displays stored bind secrets/)).toBeTruthy();
    expect(screen.getByText(/does not complete installation or restart the service/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lane qualification and host profiles" }));
    expect(screen.getAllByText(/passed, failed, skipped, or partial/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/This web app shows no qualification status/),
    ).toBeTruthy();
  });

  it("explains My profile, LDAP ownership, roles versus capabilities, and historical attribution", () => {
    const { onOpenArea } = renderHelp({ onOpenArea: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "My profile, directory ownership, and attribution" }));
    expect(screen.getByText(/first-class page at \/profile/)).toBeTruthy();
    expect(screen.getByText(/never rewrites those records/)).toBeTruthy();
    expect(screen.getByText(/Capabilities decide what you can do/)).toBeTruthy();
    expect(screen.getByText(/never contacts LDAP/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to My profile" }));
    expect(onOpenArea).toHaveBeenCalledWith("profile");
  });
});

describe("help for behavior this build ships", () => {
  it("explains how to start a question-driven triage before comparing runs", () => {
    renderHelp({ onOpenStage: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Ask a question about an investigation" }));
    expect(screen.getByText(/A triage starts with a question about one investigation/)).toBeTruthy();
    expect(screen.getByText(/Synthetic \/ offline runs are deterministic plumbing checks/)).toBeTruthy();
    expect(screen.getByText(/a focused question can use one lane, while comparisons use two or more lanes/)).toBeTruthy();
    expect(screen.getByText(/Open the Analyze stage/)).toBeTruthy();
  });

  it("explains what a slow or unanswered gateway run shows and refuses", () => {
    renderHelp({ onOpenStage: vi.fn() });
    fireEvent.click(
      screen.getByRole("button", { name: "When a gateway run is slow or does not answer" }),
    );
    // Configured is never presented as executed.
    expect(screen.getByText(/configured — no lane executed/)).toBeTruthy();
    // The host owns the deadline; cancellation keeps what already settled.
    expect(screen.getByText(/The host owns the run deadline/)).toBeTruthy();
    expect(screen.getByText(/lanes that already settled keep their recorded results/)).toBeTruthy();
    // One question is not billed twice to a slow gateway.
    expect(screen.getByText(/is refused, naming the run already running/)).toBeTruthy();
  });

  it("explains the Situation briefing without promising more than it shows", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Pick an investigation back up" }));
    expect(screen.getAllByText(/Where the investigation stands/).length).toBeGreaterThan(0);
    // The honest boundaries the surface itself keeps.
    expect(screen.getByText(/never an established cause/)).toBeTruthy();
    expect(screen.getByText(/never labeled human-authored/)).toBeTruthy();
  });

  it("describes Open threads and the bound it is read from", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "What the War Room is" }));
    expect(screen.getAllByText(/Open threads/).length).toBeGreaterThan(0);
    expect(screen.getByText(/older open work can sit outside that window/)).toBeTruthy();
  });

  it("says a copied workstream address is not an access grant", () => {
    renderHelp();
    fireEvent.click(screen.getByRole("button", { name: "Read a workstream" }));
    expect(screen.getByText(/Copy link to this workstream/)).toBeTruthy();
    expect(screen.getByText(/not an access grant/)).toBeTruthy();
  });
});
