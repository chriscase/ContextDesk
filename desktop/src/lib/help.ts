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
