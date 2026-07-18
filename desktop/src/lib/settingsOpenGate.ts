/**
 * Gate SettingsModal draft reset to open→true transitions only (#157).
 * Pure helper so unit tests can prove setup-identity churn does not wipe.
 */
export function shouldResetSettingsOnOpen(
  open: boolean,
  wasOpen: boolean,
): boolean {
  return open && !wasOpen;
}
