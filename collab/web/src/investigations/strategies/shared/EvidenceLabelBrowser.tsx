import { useState } from "react";

interface FileEntry { readonly id: string; readonly name: string }

/** Read-only projection of current, visible labels onto the loaded inventory.
 * No history events, private lanes, or orphaned artifact identities are exposed. */
export function EvidenceLabelBrowser({ files, labels }: {
  readonly files: readonly FileEntry[];
  readonly labels: readonly { readonly artifactId: string; readonly label: string }[];
}) {
  const [choice, setChoice] = useState("");
  const byId = new Map(files.map((file) => [file.id, file]));
  const groups = new Map<string, Map<string, FileEntry>>();
  for (const {artifactId, label} of labels) {
    const file = byId.get(artifactId);
    if (!file) continue;
    const group = groups.get(label) ?? new Map<string, FileEntry>();
    group.set(artifactId, file);
    groups.set(label, group);
  }
  const selected = groups.get(choice);
  return <section aria-label="Browse evidence by label">
    <h4>Browse evidence by label</h4>
    {groups.size === 0 ? <p>No current labels on the loaded evidence you can see.</p> : <>
      <label>Current evidence label
        <select value={selected ? choice : ""} onChange={(event) => setChoice(event.target.value)}>
          <option value="">Choose a label</option>
          {[...groups.keys()].sort().map((label) => <option key={label} value={label}>
            {label} ({groups.get(label)!.size})
          </option>)}
        </select>
      </label>
      {selected ? <MatchingFiles key={choice} files={[...selected.values()]} /> : null}
    </>}
  </section>;
}

function MatchingFiles({files}: {readonly files: readonly FileEntry[]}) {
  const [limit, setLimit] = useState(25);
  return <>
    <p role="status">{files.length} matching {files.length === 1 ? "file" : "files"}</p>
    <ul aria-label="Files with this label">{files.slice(0, limit).map((file) =>
      <li key={file.id}>{file.name}</li>)}</ul>
    {files.length > limit ? <button type="button" onClick={() => setLimit(limit + 25)}>Show more matching files</button> : null}
  </>;
}
