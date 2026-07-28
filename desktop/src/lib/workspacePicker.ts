export type WorkspaceDirectorySelection = string | string[] | null;

/**
 * Native picker cancellation is an expected no-op. Only a picker failure
 * should surface the packaged-app availability guidance.
 */
export async function pickWorkspaceDirectory(
  openDirectory: () => Promise<WorkspaceDirectorySelection>,
  notifyUnavailable: () => Promise<void>,
): Promise<string | null> {
  let selected: WorkspaceDirectorySelection;
  try {
    selected = await openDirectory();
  } catch {
    await notifyUnavailable();
    return null;
  }

  if (typeof selected === "string") return selected;
  if (Array.isArray(selected)) return selected[0] ?? null;
  return null;
}
