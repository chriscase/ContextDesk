/** Parse Log Explorer secondary-window boot params. */

export type ExplorerBoot =
  | { mode: "explorer"; corpusId: string; corpusName: string | null }
  | { mode: "handbook" }
  | { mode: "app" };

/**
 * Secondary Log Explorer window is opened with
 * `?window=log-explorer&corpus=<id>` (dev: Vite origin; prod: index.html?…).
 * Also accept hash form as a fallback.
 */
export function parseExplorerBoot(search: string, hash: string): ExplorerBoot {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  if (params.get("window") === "log-explorer") {
    const corpus = (params.get("corpus") ?? "").trim();
    const name = (params.get("name") ?? "").trim();
    return { mode: "explorer", corpusId: corpus, corpusName: name || null };
  }
  if (params.get("window") === "engineering-handbook") {
    return { mode: "handbook" };
  }
  const h = hash.replace(/^#/, "");
  if (h.includes("log-explorer")) {
    const hp = new URLSearchParams(h.includes("=") ? h : `window=${h}`);
    if (hp.get("window") === "log-explorer" || h.startsWith("log-explorer")) {
      const corpus = (hp.get("corpus") ?? "").trim();
      const name = (hp.get("name") ?? "").trim();
      return { mode: "explorer", corpusId: corpus, corpusName: name || null };
    }
  }
  return { mode: "app" };
}
