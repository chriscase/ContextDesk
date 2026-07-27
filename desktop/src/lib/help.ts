export type HelpLocation = {
  pageId: string;
  anchor?: string;
};

export type HelpOpenRequest = {
  requestId: number;
  pageId?: string;
  anchor?: string;
  query?: string;
  focusSearch?: boolean;
};

const HELP_OPEN_EVENT = "contextdesk:help-open";
const HELP_OPEN_STORAGE_KEY = "contextdesk.help.open.v1";
let helpRequestSequence = 0;

/** Parse only canonical in-app Help locators; never treat them as URLs or paths. */
export function parseHelpLocator(value: string): HelpLocation | null {
  const match = value
    .trim()
    .match(/^help:\/\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/);
  if (!match) return null;
  return { pageId: match[1], anchor: match[2] || undefined };
}

export function helpOpenRequest(
  requestId: number,
  location: {
    pageId?: string;
    anchor?: string;
    query?: string;
    focusSearch?: boolean;
  },
): HelpOpenRequest {
  return {
    requestId,
    pageId: location.pageId,
    anchor: location.anchor,
    query: location.query,
    focusSearch: location.focusSearch,
  };
}

/** Ask the main app window to open canonical Help without closing this window. */
export function requestHelpAcrossWindows(location: HelpLocation): void {
  const locator = `help://${location.pageId}${location.anchor ? `#${location.anchor}` : ""}`;
  const parsed = parseHelpLocator(locator);
  if (!parsed) return;
  window.dispatchEvent(
    new CustomEvent<HelpLocation>(HELP_OPEN_EVENT, { detail: parsed }),
  );
  try {
    helpRequestSequence += 1;
    localStorage.setItem(
      HELP_OPEN_STORAGE_KEY,
      JSON.stringify({
        ...parsed,
        requestedAt: Date.now(),
        requestSequence: helpRequestSequence,
      }),
    );
  } catch {
    // Same-window custom event still works when storage is unavailable.
  }
}

/** Subscribe in the main window to same-window and Explorer-window requests. */
export function subscribeHelpAcrossWindows(
  onOpen: (location: HelpLocation) => void,
): () => void {
  const onCustom = (event: Event) => {
    const location = (event as CustomEvent<HelpLocation>).detail;
    const locator = location
      ? `help://${location.pageId}${location.anchor ? `#${location.anchor}` : ""}`
      : "";
    const parsed = parseHelpLocator(locator);
    if (parsed) onOpen(parsed);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== HELP_OPEN_STORAGE_KEY || !event.newValue) return;
    try {
      const value = JSON.parse(event.newValue) as Partial<HelpLocation>;
      const locator =
        typeof value.pageId === "string"
          ? `help://${value.pageId}${typeof value.anchor === "string" ? `#${value.anchor}` : ""}`
          : "";
      const parsed = parseHelpLocator(locator);
      if (parsed) onOpen(parsed);
    } catch {
      // Malformed cross-window data fails closed.
    }
  };
  window.addEventListener(HELP_OPEN_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HELP_OPEN_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stable contextual Help target for each Settings family. */
export function helpPageForSettingsSection(section: string): string {
  if (section === "ai") {
    return "provider-setup";
  }
  if (section === "workspace") {
    return "workspace-indexing";
  }
  if (section === "backup") {
    return "s3-backup";
  }
  if (section === "connectors") {
    return "connectors-and-confluence";
  }
  if (section === "health") {
    return "first-run";
  }
  if (section === "skills" || section === "modules") {
    return "skills-context-packs";
  }
  return "product-overview";
}
