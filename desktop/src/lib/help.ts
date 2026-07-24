export type HelpLocation = {
  pageId: string;
  anchor?: string;
};

export type HelpOpenRequest = {
  requestId: number;
  pageId?: string;
  anchor?: string;
  query?: string;
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
  location: { pageId?: string; anchor?: string; query?: string },
): HelpOpenRequest {
  return {
    requestId,
    pageId: location.pageId,
    anchor: location.anchor,
    query: location.query,
  };
}
